import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
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
export const EXECUTION_ENGINE_VERSION = 'engine-2026.09-c7';

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

export function executionRevision(s: ExecutionSnapshot): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))));
  return `suite_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

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
