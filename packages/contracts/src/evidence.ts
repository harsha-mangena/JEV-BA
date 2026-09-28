import { z } from 'zod';
import { ReasonCode, Verdict } from './verdict.ts';

export const EvidenceEventKind = z.enum([
  'run_started',
  'fixture_provisioned',
  'navigation',
  'intent',
  'assertion',
  'policy',
  'console_error',
  'network_blocked',
  'artifact',
  'milestone',
  'decision',
  'cleanup',
  'case_finished',
  'run_finished',
  'intent_transition',
]);

export const EvidenceEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  attempt_id: z.string(),
  kind: EvidenceEventKind,
  summary: z.string(),
  data: z.record(z.unknown()).default({}),
});
export type EvidenceEvent = z.infer<typeof EvidenceEvent>;

export const AssertionResult = z.object({
  milestone_id: z.string(),
  index: z.number().int(),
  type: z.string(),
  status: z.enum(['passed', 'failed', 'not_run', 'needs_review']),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  message: z.string().optional(),
  elapsed_ms: z.number(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

export const ArtifactRef = z.object({
  kind: z.enum(['screenshot', 'trace', 'events', 'report', 'dom', 'visual_candidate', 'visual_diff', 'a11y']),
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const CaseResult = z.object({
  scenario_id: z.string(),
  requirement_ids: z.array(z.string()),
  execution_profile: z.string(),
  attempt_id: z.string(),
  critical: z.boolean(),
  verdict: Verdict,
  reason: ReasonCode.nullable(),
  message: z.string().nullable(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  milestones_completed: z.array(z.string()),
  assertions: z.array(AssertionResult),
  artifacts: z.array(ArtifactRef),
  cleanup: z.object({ status: z.enum(['done', 'failed', 'skipped', 'pending']), detail: z.string().optional() }),
  /** Earlier attempts under the same contract, preserved so a later success never hides a failure. */
  prior_attempts: z
    .array(z.object({ attempt_id: z.string(), verdict: Verdict, reason: ReasonCode.nullable(), message: z.string().nullable() }))
    .default([]),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const RunReport = z.object({
  schema_version: z.literal(1),
  run_id: z.string(),
  base_url: z.string(),
  environment: z.string(),
  commit_sha: z.string().nullable(),
  deployment_id: z.string().nullable(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  cases: z.array(CaseResult),
  gate: z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }),
});
export type RunReport = z.infer<typeof RunReport>;
