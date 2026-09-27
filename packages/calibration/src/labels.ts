import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { GateFeatures, type RunReport } from '@qa/contracts';

/** Everything that must match for a calibration to apply (plan Phase 8). */
export const DecisionConfig = z.object({
  model: z.string(),
  question_schema_version: z.string(),
  extractor_version: z.string(),
  policy_digest: z.string(),
  candidate_filter_version: z.string(),
  gate_version: z.string(),
});
export type DecisionConfig = z.infer<typeof DecisionConfig>;

export const digestConfig = (c: DecisionConfig) => createHash('sha256').update(JSON.stringify(Object.entries(c).sort())).digest('hex').slice(0, 16);

export const LabelCategory = z.enum([
  'correct',
  'wrong_operation',
  'wrong_target',
  'wrong_parameter',
  'policy_incompatible',
  'wrong_milestone',
  /** Extraction failures: the right action was not offered. Reported separately; not fitted as model errors. */
  'correct_target_absent',
  'unsupported_control',
  'insufficient_evidence',
]);
export type LabelCategory = z.infer<typeof LabelCategory>;
export const OBSERVATION_FAILURES: ReadonlySet<LabelCategory> = new Set(['correct_target_absent', 'unsupported_control']);

export const LabeledDecision = z.object({
  decision_id: z.string(),
  app_id: z.string(),
  journey_id: z.string(),
  deployment_id: z.string(),
  decision_config: DecisionConfig,
  features: GateFeatures,
  label: z.object({ category: LabelCategory, valid_alternatives: z.array(z.string()).default([]) }),
  annotations: z.array(z.object({ annotator: z.string(), category: LabelCategory })).default([]),
  adjudicated: z.boolean().default(false),
});
export type LabeledDecision = z.infer<typeof LabeledDecision>;

export const isCorrect = (d: LabeledDecision) => d.label.category === 'correct';
export const cohortOf = (d: Pick<LabeledDecision, 'features'>) => `${d.features.risk_class}/${d.features.op}`;

/** Unlabeled decision records from exploration evidence, ready for a labeling tool. */
export async function extractDecisions(runDir: string, app_id: string, decision_config: DecisionConfig): Promise<Array<Omit<LabeledDecision, 'label' | 'annotations' | 'adjudicated'>>> {
  const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as RunReport;
  const out = [];
  for (const c of report.cases) {
    const ev = c.artifacts.find((a) => a.kind === 'events');
    if (!ev) continue;
    for (const line of (await readFile(join(runDir, ev.path), 'utf8')).split('\n').filter(Boolean)) {
      const e = JSON.parse(line) as { kind: string; data: { decision_id?: string; features?: unknown; source?: string } };
      if (e.kind !== 'decision' || !e.data.decision_id || !e.data.features || e.data.source !== 's1') continue;
      const f = GateFeatures.safeParse(e.data.features);
      if (!f.success) continue;
      out.push({ decision_id: e.data.decision_id, app_id, journey_id: `${c.scenario_id}@${c.execution_profile}`, deployment_id: report.deployment_id ?? report.run_id, decision_config, features: f.data });
    }
  }
  return out;
}

/** Inter-annotator agreement (fraction of decisions where every annotator agreed). */
export function agreement(data: LabeledDecision[]): { multiply_annotated: number; unanimous: number; rate: number } {
  const multi = data.filter((d) => d.annotations.length >= 2);
  const unanimous = multi.filter((d) => new Set(d.annotations.map((a) => a.category)).size === 1).length;
  return { multiply_annotated: multi.length, unanimous, rate: multi.length ? unanimous / multi.length : NaN };
}
