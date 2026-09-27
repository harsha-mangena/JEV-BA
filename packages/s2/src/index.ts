import { z } from 'zod';
import type { Observation } from '@qa/contracts';

const Evidence = z.array(z.string().max(200)).max(10);

/**
 * The only shapes System Two may return. Strict objects: extra fields such as
 * selectors, scripts, permissions or assertion edits are rejected outright.
 */
export const S2Proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SELECT_OBSERVED_TARGET'), node_id: z.string().min(1), evidence_refs: Evidence, reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('REQUEST_CONTEXT'), need: z.enum(['full_candidate_list', 'screenshot', 'scroll_region', 'wait_for_load']), evidence_refs: Evidence, reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('PROPOSE_SUBGOAL'), subgoal: z.string().min(1).max(300), evidence_refs: Evidence, reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('ABSTAIN'), evidence_refs: Evidence, reason: z.string().max(500) }).strict(),
]);
export type S2Proposal = z.infer<typeof S2Proposal>;

export interface S2EscalationInput {
  goal: string;
  milestone_id: string;
  observation: Observation;
  s1_distributions: Record<string, Record<string, number>>;
  unmet_assertions: string[];
  environment_policy_summary: string;
  missing_information: string[];
  screenshot_png?: Buffer;
}

export interface SystemTwoProvider {
  readonly id: string;
  readonly supportsImages: boolean;
  propose(input: S2EscalationInput, signal?: AbortSignal): Promise<unknown>;
}

export type S2Validation = { ok: true; proposal: S2Proposal } | { ok: false; error: string };

/**
 * Validate an S2 answer. A selected target must be one of the observation's
 * candidates; the result then re-enters the same freshness, permission and
 * actionability checks as an S1 decision — S2 never authorizes anything.
 */
export function validateS2Proposal(raw: unknown, obs: Observation): S2Validation {
  const r = S2Proposal.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const p = r.data;
  if (p.kind === 'SELECT_OBSERVED_TARGET' && !obs.candidates.some((c) => c.node_id === p.node_id)) {
    return { ok: false, error: `node ${p.node_id} is not an observed candidate` };
  }
  return { ok: true, proposal: p };
}
