import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario, type RunReport } from '@qa/contracts';
import { applyRepair, compileJourney, emitPlaywrightSpec, proposeLocatorRepair, validateRepair, type RepairProposal } from '@qa/compiler';
import { UsageError, type ServiceArgs } from './service.ts';

const runDirOf = (a: ServiceArgs) => {
  const r = Array.isArray(a.run) ? a.run[0] : a.run;
  if (!r) throw new UsageError('--run <run dir> is required');
  return resolve(r as string);
};

async function load(a: ServiceArgs) {
  const specs = resolve((a.specs as string) ?? 'specs');
  const policy = await loadPolicy(join(specs, 'policies/fixture-shop.yaml'));
  const catalog = await loadFixtureCatalog(join(specs, 'fixtures.yaml'));
  return { specs, policy, catalog };
}

/** Compile a passed exploration case into a proposed regression scenario (+ Playwright spec export). */
export async function compile(a: ServiceArgs): Promise<number> {
  const { specs, policy, catalog } = await load(a);
  const runDir = runDirOf(a);
  const id = (a.scenario as string[] | undefined)?.[0];
  if (!id) throw new UsageError('--scenario <exploration id> is required');
  const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as RunReport;
  const result = report.cases.find((c) => c.scenario_id === id);
  if (!result) throw new UsageError(`no case for ${id} in ${runDir}`);
  const source = await loadValidatedScenario(join(specs, 'exploration', `${id}.yaml`), catalog, policy);
  const r = await compileJourney({ runDir, result, source, catalog, policy });
  if (!r.ok) {
    for (const e of r.errors) console.error(`cannot compile: ${e}`);
    return 1;
  }
  await mkdir(join(specs, 'proposals'), { recursive: true });
  await writeFile(join(specs, 'proposals', `${r.scenario.id}.yaml`), stringify({ source: 'compiler', rationale: `Compiled from verified exploration ${result.attempt_id} in ${report.run_id}`, scenario: r.scenario, oracles: r.oracles }));
  console.log(`proposed ${r.scenario.id} (approve with: qa proposals approve ${r.scenario.id} --approver <name>)`);
  try {
    await writeFile(join(specs, 'proposals', `${r.scenario.id}.spec.ts`), emitPlaywrightSpec(r.scenario));
    console.log(`Playwright export: specs/proposals/${r.scenario.id}.spec.ts`);
  } catch (e) {
    console.log(`no Playwright export: ${(e as Error).message}`);
  }
  return 0;
}

export async function repair(sub: string | undefined, a: ServiceArgs): Promise<number> {
  const { specs, policy, catalog } = await load(a);
  if (sub === 'propose') {
    const runDir = runDirOf(a);
    const id = (a.scenario as string[] | undefined)?.[0];
    if (!id) throw new UsageError('--scenario <id> is required');
    const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as RunReport;
    const scenario = await loadValidatedScenario(join(specs, 'scenarios', `${id}.yaml`), catalog, policy);
    for (const c of report.cases.filter((x) => x.scenario_id === id)) {
      const p = await proposeLocatorRepair({ runDir, result: c, scenario });
      if ('none' in p) {
        console.log(`${c.execution_profile}: no repair proposed — ${p.none}`);
        continue;
      }
      const out = join(specs, 'proposals', `${id}.repair.json`);
      await mkdir(join(specs, 'proposals'), { recursive: true });
      await writeFile(out, JSON.stringify(p, null, 2));
      console.log(`${c.execution_profile}: proposed ${p.kind} repair → ${out}\n${p.patch.map((x) => `  ${x.path}: ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`).join('\n')}`);
      return 0;
    }
    return 1;
  }
  if (sub === 'apply') {
    const file = (a.config as string) ?? '';
    if (!file || !a.approver) throw new UsageError('usage: qa repair apply --config <repair.json> --approver <name>');
    const p = JSON.parse(await readFile(resolve(file), 'utf8')) as RepairProposal;
    const path = join(specs, 'scenarios', `${p.scenario_id}.yaml`);
    const original = await loadValidatedScenario(path, catalog, policy);
    const repaired = applyRepair(original, p);
    const v = validateRepair(original, repaired);
    if (!v.ok) {
      for (const x of v.violations) console.error(`rejected: ${x}`);
      console.error('This is a semantic requirement change; edit the scenario through normal review instead.');
      return 1;
    }
    const raw = parseYaml(await readFile(path, 'utf8')) as Record<string, unknown>;
    const patched = applyRepairToRaw(raw, p);
    const text = stringify(patched);
    await writeFile(path, text);
    await appendFile(join(specs, 'approvals.jsonl'), `${JSON.stringify({ scenario_id: p.scenario_id, source: 'repair', classification: v.classification, approver: a.approver, approved_at: new Date().toISOString(), from_sha256: p.from_sha256, sha256: createHash('sha256').update(text).digest('hex'), patch: p.patch })}\n`);
    console.log(`applied ${v.classification} repair to ${path}; rerun the scenario cleanly before merging`);
    return 0;
  }
  throw new UsageError('usage: qa repair propose|apply');
}

/** Apply the same patch to the authored YAML so comments-free source stays minimal. */
function applyRepairToRaw(raw: Record<string, unknown>, p: RepairProposal): Record<string, unknown> {
  const copy = structuredClone(raw);
  for (const x of p.patch) {
    const keys = x.path.split('.');
    let node: Record<string, unknown> = copy;
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
    node[keys.at(-1)!] = x.to;
  }
  return copy;
}
