import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario } from '@qa/contracts';
import {
  explorationBoundaries,
  GitDiffProvider,
  learnRouteUsage,
  loadCoverageGraph,
  proposalsFromEquivalenceClasses,
  selectImpacted,
  transitionCoverage,
  validateProposal,
  type RouteUsage,
} from '@qa/coverage';
import { readdir } from 'node:fs/promises';
import { UsageError, type ServiceArgs } from './service.ts';

async function ctx(a: ServiceArgs) {
  const specs = resolve((a.specs as string) ?? 'specs');
  return {
    specs,
    graph: await loadCoverageGraph(join(specs, 'coverage.yaml')),
    policy: await loadPolicy(join(specs, 'policies/fixture-shop.yaml')),
    catalog: await loadFixtureCatalog(join(specs, 'fixtures.yaml')),
  };
}

async function readUsage(path: string): Promise<RouteUsage> {
  return JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as RouteUsage;
}

/** Print the selection manifest for base..head in a local repository. */
export async function select(a: ServiceArgs): Promise<number> {
  const c = await ctx(a);
  const scenarios = [];
  for (const dir of ['scenarios', 'exploration']) {
    for (const f of (await readdir(join(c.specs, dir)).catch(() => [])).filter((x) => x.endsWith('.yaml'))) scenarios.push(await loadValidatedScenario(join(c.specs, dir, f), c.catalog, c.policy));
  }
  const head = a.head as string;
  if (!head) throw new UsageError('--head is required');
  const comparison = await new GitDiffProvider(resolve((a.repo as string) ?? '.')).compare((a.base as string) ?? null, head);
  const manifest = selectImpacted({
    graph: c.graph,
    scenarios,
    environment: (a.environment as string) ?? 'staging',
    suite_revision: 'local',
    candidate_sha: head,
    comparison,
    usage: await readUsage(join(c.specs, 'coverage-usage.json')),
  });
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

export async function coverage(sub: string | undefined, a: ServiceArgs): Promise<number> {
  const c = await ctx(a);
  const runs = ((a.run as string[] | string | undefined) ?? []) as string[] | string;
  const dirs = (Array.isArray(runs) ? runs : [runs]).map((r) => resolve(r));
  if (!dirs.length) throw new UsageError('--run <run dir> is required');
  if (sub === 'learn') {
    const path = join(c.specs, 'coverage-usage.json');
    const usage = await learnRouteUsage(dirs, c.graph, await readUsage(path));
    await writeFile(path, `${JSON.stringify(usage, null, 2)}\n`);
    console.log(`observed route usage written to ${path}`);
    return 0;
  }
  if (sub === 'transitions') {
    console.log(JSON.stringify(await transitionCoverage(dirs, c.graph), null, 2));
    return 0;
  }
  if (sub === 'boundaries') {
    for (const d of dirs) console.log(JSON.stringify(await explorationBoundaries(d, c.graph), null, 2));
    return 0;
  }
  throw new UsageError('usage: qa coverage learn|transitions|boundaries --run <dir>');
}

/** Proposals live in specs/proposals and gate nothing until approved into specs/scenarios. */
export async function proposals(sub: string | undefined, id: string | undefined, a: ServiceArgs): Promise<number> {
  const c = await ctx(a);
  const dir = join(c.specs, 'proposals');
  if (sub === 'generate') {
    await mkdir(dir, { recursive: true });
    for (const p of proposalsFromEquivalenceClasses(c.graph)) {
      const sid = (p.scenario as { id: string }).id;
      await writeFile(join(dir, `${sid}.yaml`), stringify(p));
      console.log(`proposed ${sid}`);
    }
    return 0;
  }
  if (!id) throw new UsageError(`usage: qa proposals ${sub ?? 'validate|approve'} <id>`);
  const raw = parseYaml(await readFile(join(dir, `${id}.yaml`), 'utf8'));
  const v = validateProposal(raw, c);
  if (!v.ok) {
    for (const e of v.errors) console.error(`invalid: ${e}`);
    return 1;
  }
  if (sub === 'validate') {
    console.log(`valid proposal ${id}${v.warnings.length ? ` (warnings: ${v.warnings.join('; ')})` : ''}`);
    return 0;
  }
  if (sub === 'approve') {
    if (!a.approver) throw new UsageError('--approver is required');
    const target = join(c.specs, 'scenarios', `${id}.yaml`);
    if (await access(target).then(() => true, () => false)) throw new UsageError(`${target} already exists; changes to approved scenarios go through repair review`);
    const text = stringify(raw.scenario);
    await writeFile(target, text);
    await appendFile(join(c.specs, 'approvals.jsonl'), `${JSON.stringify({ scenario_id: id, source: raw.source, approver: a.approver, approved_at: new Date().toISOString(), sha256: createHash('sha256').update(text).digest('hex'), oracles: raw.oracles })}\n`);
    console.log(`approved ${id} → ${target}`);
    return 0;
  }
  throw new UsageError('usage: qa proposals generate|validate|approve');
}
