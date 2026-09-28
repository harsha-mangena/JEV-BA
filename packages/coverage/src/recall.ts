import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Scenario } from '@qa/contracts';
import type { CoverageGraph } from './graph.ts';
import { selectImpacted } from './select.ts';

export const SelectionBenchmark = z
  .object({
    schema_version: z.literal(1),
    cases: z.array(z.object({ defect: z.string().min(1), changed: z.array(z.string().min(1)).min(1), detected_by: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  })
  .strict();
export type SelectionBenchmark = z.infer<typeof SelectionBenchmark>;

export interface RecallReport {
  cases: number;
  caught: number;
  recall: number;
  /** Mean fraction of the required regression suite selected (lower is cheaper; recall comes first). */
  mean_selected_fraction: number;
  full_suite_cases: number;
  missed: Array<{ defect: string; changed: string[]; detected_by: string[]; selected: string[] }>;
  per_case: Array<{ defect: string; caught: boolean; selected: number; full_suite: boolean }>;
}

export async function loadSelectionBenchmark(path: string): Promise<SelectionBenchmark> {
  return SelectionBenchmark.parse(parse(await readFile(path, 'utf8')));
}

/**
 * Measure change-impact selection against a labelled benchmark: for each
 * seeded defect, select for a change that would introduce it and check that
 * a scenario proven to detect it is selected. A miss is a false-pass risk.
 */
export function measureSelectionRecall(b: SelectionBenchmark, graph: CoverageGraph, scenarios: Scenario[], environment = 'staging'): RecallReport {
  const known = new Set(scenarios.map((s) => s.id));
  for (const c of b.cases) for (const d of c.detected_by) if (!known.has(d)) throw new Error(`benchmark case ${c.defect} names unknown scenario ${d}`);
  const regression = scenarios.filter((s) => s.mode === 'regression' && s.policy.environments.includes(environment));
  const total = new Set(regression.map((s) => s.id)).size;
  const per_case: RecallReport['per_case'] = [];
  const missed: RecallReport['missed'] = [];
  let fractions = 0;
  for (const c of b.cases) {
    const m = selectImpacted({ graph, scenarios, environment, suite_revision: 'recall', candidate_sha: 'f'.repeat(40), comparison: { kind: 'ok', base: 'a'.repeat(40), head: 'b'.repeat(40), files: c.changed.map((path) => ({ path, status: 'modified' as const })) } });
    const selected = [...new Set(m.cases.map((x) => x.scenario_id))];
    const caught = c.detected_by.some((d) => selected.includes(d));
    fractions += total ? selected.length / total : 1;
    per_case.push({ defect: c.defect, caught, selected: selected.length, full_suite: m.strategy === 'full' });
    if (!caught) missed.push({ defect: c.defect, changed: c.changed, detected_by: c.detected_by, selected: selected.sort() });
  }
  const caught = per_case.filter((p) => p.caught).length;
  return { cases: b.cases.length, caught, recall: caught / b.cases.length, mean_selected_fraction: fractions / b.cases.length, full_suite_cases: per_case.filter((p) => p.full_suite).length, missed, per_case };
}
