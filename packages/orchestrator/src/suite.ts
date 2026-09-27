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

export interface LoadedSuite {
  scenarios: Scenario[];
  policy: ProjectPolicy;
  catalog: FixtureCatalog;
  /** Content hash of every file that defines expected behaviour; a change invalidates earlier results. */
  revision: string;
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
  return { scenarios, policy, catalog, revision: `suite_${hash.digest('hex').slice(0, 16)}`, root: at(cfg.suite.specs_dir) };
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
