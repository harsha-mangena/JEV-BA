import { z } from 'zod';
import { ExecutionProfileId } from './scenario.ts';

export const SelectionReason = z.enum(['mandatory_smoke', 'impacted', 'risk_triggered', 'full_suite', 'unknown_impact', 'requested']);

/**
 * Versioned record of what a run will execute and why. Every selection and
 * every omission carries an explanation; the gate is evaluated against
 * exactly this expected set.
 */
export const SelectionManifest = z.object({
  version: z.literal(1),
  suite_revision: z.string(),
  strategy: z.enum(['full', 'impact']),
  base_sha: z.string().nullable(),
  candidate_sha: z.string(),
  cases: z.array(z.object({ scenario_id: z.string(), execution_profile: ExecutionProfileId, required: z.boolean(), reasons: z.array(z.string()) })),
  omitted: z.array(z.object({ scenario_id: z.string(), reason: z.string() })),
  exploration: z.array(z.object({ scenario_id: z.string(), execution_profile: ExecutionProfileId, reasons: z.array(z.string()) })),
  gaps: z.array(z.object({ kind: z.enum(['requirement_without_scenario', 'unmapped_path', 'renamed_path', 'missing_comparison']), subject: z.string(), detail: z.string() })),
  explanation: z.array(z.string()),
});
export type SelectionManifest = z.infer<typeof SelectionManifest>;
