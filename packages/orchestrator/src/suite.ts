import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { EXECUTION_PROFILES, pinnedBrowserIdentity } from '@qa/browser';
import { FIXTURE_ADAPTER } from '@qa/oracles';
import type { BaselineStore } from '@qa/quality';
import {
  loadFixtureCatalog,
  loadPolicy,
  loadValidatedScenario,
  type ExecutionProfileId,
  type FixtureCatalog,
  type ProjectConfig,
  type ProjectPolicy,
  type Scenario,
  type SelectionManifest,
} from '@qa/contracts';

/**
 * Version of the execution semantics (runner, oracles, authorization, observation).
 * Bump when a change could alter a verdict for unchanged specs; it is part of the
 * execution snapshot, so results produced by an older engine stop qualifying.
 */
export const EXECUTION_ENGINE_VERSION = 'engine-2026.09-r2';

/** Everything that decides what a run must prove, beyond the spec files themselves. */
export interface ExecutionSnapshot {
  engine: string;
  specs_digest: string;
  contract_version: string;
  required_profiles: string[] | 'scenario-declared';
  scenario_filter: string[] | 'all';
  retries: number;
  signed_out_path: string | null;
  coverage_file: boolean;
}

export interface LoadedSuite {
  scenarios: Scenario[];
  policy: ProjectPolicy;
  catalog: FixtureCatalog;
  /**
   * Digest of the execution snapshot: every spec/policy/catalog file plus the
   * effective execution configuration (required profiles, scenario filter,
   * retries, engine version). Any change invalidates earlier results (audit F05).
   */
  revision: string;
  snapshot: ExecutionSnapshot;
  root: string;
}

export async function loadSuite(cfg: ProjectConfig, baseDir: string): Promise<LoadedSuite> {
  const at = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const hash = createHash('sha256');
  const read = async (p: string) => {
    const text = await readFile(p, 'utf8');
    hash.update(p.slice(at(cfg.suite.specs_dir).length)).update('\0').update(text).update('\0');
  };
  const policyPath = at(cfg.suite.policy_file);
  const catalogPath = at(cfg.suite.fixture_catalog);
  await read(policyPath);
  await read(catalogPath);
  const policy = await loadPolicy(policyPath);
  const catalog = await loadFixtureCatalog(catalogPath);
  const scenarios: Scenario[] = [];
  for (const dir of ['scenarios', 'exploration']) {
    const full = join(at(cfg.suite.specs_dir), dir);
    const files = (await readdir(full).catch(() => [] as string[])).filter((f) => f.endsWith('.yaml')).sort();
    for (const f of files) {
      if (cfg.suite.scenarios && !cfg.suite.scenarios.includes(f.replace(/\.yaml$/, ''))) continue;
      await read(join(full, f));
      scenarios.push(await loadValidatedScenario(join(full, f), catalog, policy));
    }
  }
  if (cfg.suite.coverage_file) await read(at(cfg.suite.coverage_file));
  const snapshot: ExecutionSnapshot = {
    engine: EXECUTION_ENGINE_VERSION,
    specs_digest: hash.digest('hex'),
    contract_version: policy.contract_version,
    required_profiles: cfg.suite.profiles ? [...cfg.suite.profiles].sort() : 'scenario-declared',
    scenario_filter: cfg.suite.scenarios ? [...cfg.suite.scenarios].sort() : 'all',
    retries: cfg.suite.retries,
    signed_out_path: cfg.suite.signed_out_path ?? null,
    coverage_file: !!cfg.suite.coverage_file,
  };
  return { scenarios, policy, catalog, revision: executionRevision(snapshot), snapshot, root: at(cfg.suite.specs_dir) };
}

/** Stable JSON: object keys sorted at every depth, so equal contracts always hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

export function executionRevision(s: ExecutionSnapshot): string {
  return `suite_${digest(s).slice(0, 16)}`;
}

/**
 * The complete typed execution contract of a run (re-audit R2): everything
 * that can change a verdict for an unchanged deployment. Its digest is the
 * run's revision; it is computed at submission, re-checked before every shard
 * executes, at aggregation and at every gate/promotion evaluation, so a
 * result never qualifies under a contract other than the one it was produced
 * under. Secret references are hashed; secret values are never included.
 */
export interface ExecutionContract {
  schema: 2;
  /** Spec/policy/catalog files and suite-level execution settings. */
  suite: ExecutionSnapshot;
  /** The effective environment policy the run executes under. */
  environment: { name: string; policy: unknown };
  /** Oracle/application adapter: identity, version and the endpoint it reads truth from. */
  oracle: { adapter: string; adapter_version: string; endpoint: string; token_ref_sha256: string };
  /** How the candidate's revision is verified before and after execution. */
  verification: { version_check: unknown };
  /** Approved visual baselines frozen at submission: execution compares against exactly these versions. */
  baselines: FrozenBaseline[];
  /** Browser builds and context options for every profile the run may execute. */
  rendering: { playwright: string; profiles: Record<string, { browser: string; browser_version: string | null; options_sha256: string }> };
  /**
   * Decision configuration that can decide a required verdict. Only approved
   * assertions and the release-gate rules (versioned with the engine) do;
   * exploration decisions are advisory and are never part of the required gate.
   */
  decision: { required_verdicts: 'approved-assertions-only'; exploration: 'advisory-never-gating' };
}

export interface FrozenBaseline {
  scenario_id: string;
  checkpoint: string;
  execution_profile: string;
  rendering_profile: string;
  version: number;
  sha256: string;
}

export interface ResolvedExecution {
  contract: ExecutionContract;
  /** Digest of the contract: the run's revision. */
  revision: string;
}

export async function resolveExecution(cfg: ProjectConfig, environment: string, suite: LoadedSuite, o: { baselines?: BaselineStore | null } = {}): Promise<ResolvedExecution> {
  const scenarios = new Set(suite.scenarios.map((x) => x.id));
  const profiles = [...new Set(suite.scenarios.flatMap((x) => x.execution_profiles).filter((p) => !cfg.suite.profiles || cfg.suite.profiles.includes(p)))].sort();
  const pinned = pinnedBrowserIdentity();
  const baselines = ((await o.baselines?.list()) ?? [])
    .filter((b) => scenarios.has(b.key.scenario_id) && profiles.includes(b.key.execution_profile as ExecutionProfileId))
    .map((b) => ({ ...b.key, version: b.version, sha256: b.sha256 }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const contract: ExecutionContract = {
    schema: 2,
    suite: suite.snapshot,
    environment: { name: environment, policy: cfg.environments[environment] ?? null },
    oracle: {
      adapter: FIXTURE_ADAPTER.id,
      adapter_version: FIXTURE_ADAPTER.adapter_version,
      endpoint: cfg.fixture_api.url ? new URL(cfg.fixture_api.url).href : 'candidate-url',
      token_ref_sha256: createHash('sha256').update(`env:${cfg.fixture_api.token_env}`).digest('hex'),
    },
    verification: { version_check: cfg.version_check },
    baselines,
    rendering: {
      playwright: pinned.playwright,
      profiles: Object.fromEntries(
        profiles.map((p) => {
          const prof = EXECUTION_PROFILES[p as ExecutionProfileId];
          return [p, { browser: prof.browser, browser_version: pinned.browsers[prof.browser], options_sha256: digest(prof.options) }];
        }),
      ),
    },
    decision: { required_verdicts: 'approved-assertions-only', exploration: 'advisory-never-gating' },
  };
  return { contract, revision: `exec_${digest(contract).slice(0, 24)}` };
}

/** Human-readable differences between two contracts (top-level sections and keys), for stale-result reasons. */
export function contractChanges(before: unknown, after: ExecutionContract): string[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(after).sort()) {
    const x = b[k];
    const y = (after as unknown as Record<string, unknown>)[k];
    if (canonicalJson(x) === canonicalJson(y)) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      const keys = [...new Set([...Object.keys(x as object), ...Object.keys(y as object)])].sort();
      const changed = keys.filter((kk) => canonicalJson((x as Record<string, unknown>)[kk]) !== canonicalJson((y as Record<string, unknown>)[kk]));
      out.push(`${k}: ${changed.join(', ') || 'changed'}`);
    } else out.push(k);
  }
  return out;
}

/** Identity of the frozen selection manifest a run executes (separate from the contract). */
export const selectionDigest = (m: SelectionManifest) => `sel_${digest(m).slice(0, 24)}`;

/** Full-suite selection used when no impact analysis is available (Phase 6 refines this). */
export function selectFullSuite(suite: LoadedSuite, cfg: ProjectConfig, environment: string, candidateSha: string, reason = 'full_suite'): SelectionManifest {
  const profileOk = (p: ExecutionProfileId) => !cfg.suite.profiles || cfg.suite.profiles.includes(p);
  const eligible = (s: Scenario) => s.policy.environments.includes(environment);
  const manifest: SelectionManifest = {
    version: 1,
    suite_revision: suite.revision,
    strategy: 'full',
    base_sha: null,
    candidate_sha: candidateSha,
    cases: [],
    omitted: [],
    exploration: [],
    gaps: [],
    explanation: [`${reason}: every approved regression scenario permitted in ${environment}`],
  };
  for (const s of suite.scenarios) {
    if (!eligible(s)) {
      manifest.omitted.push({ scenario_id: s.id, reason: `not permitted in environment ${environment}` });
      continue;
    }
    for (const p of s.execution_profiles.filter(profileOk)) {
      if (s.mode === 'regression') manifest.cases.push({ scenario_id: s.id, execution_profile: p, required: true, reasons: [s.critical ? 'mandatory_smoke' : reason] });
      else manifest.exploration.push({ scenario_id: s.id, execution_profile: p, reasons: ['bounded exploration (advisory)'] });
    }
  }
  return manifest;
}

/** Deterministic round-robin sharding of required cases. */
export function shard<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, () => []);
  items.forEach((it, i) => out[i % out.length]!.push(it));
  return out;
}
