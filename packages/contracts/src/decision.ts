import { z } from 'zod';
import { Operation } from './observation.ts';

export const GateOutcome = z.enum(['DENY', 'REOBSERVE', 'ACT', 'ESCALATE', 'ABSTAIN']);
export type GateOutcome = z.infer<typeof GateOutcome>;

export const RiskClass = z.enum(['read_only', 'reversible_input', 'test_owned_mutation', 'external_effect', 'unknown']);
export type RiskClass = z.infer<typeof RiskClass>;

export const Distribution = z.record(z.number());

export const GateFeatures = z.object({
  op: Operation,
  op_probability: z.number(),
  op_margin: z.number(),
  target_probability: z.number().nullable(),
  target_margin: z.number().nullable(),
  /** Product of the two scores — an uncalibrated feature, *not* a joint probability. */
  pair_score: z.number().nullable(),
  provider_confidence: z.number().nullable(),
  candidate_count: z.number().int(),
  candidates_truncated: z.boolean(),
  argument_valid: z.boolean(),
  fresh: z.boolean(),
  risk_class: RiskClass,
  recent_no_effect: z.number().int(),
});
export type GateFeatures = z.infer<typeof GateFeatures>;

export const DecisionRecord = z.object({
  decision_id: z.string(),
  observation_id: z.string(),
  requested_model: z.string(),
  resolved_model: z.string().nullable(),
  question_schema_hash: z.string(),
  candidate_set_hash: z.string(),
  op_distribution: Distribution,
  target_distribution: Distribution.nullable(),
  features: GateFeatures,
  gate_config_version: z.string(),
  calibration_version: z.string().nullable(),
  outcome: GateOutcome,
  reason_codes: z.array(z.string()),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).partial(),
  elapsed_ms: z.number(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const ActionIntent = z.object({
  intent_id: z.string(),
  attempt_id: z.string(),
  observation_id: z.string().nullable(),
  operation: Operation,
  target: z.string().nullable(),
  /** Reference such as `fixture.address`; the literal secret is resolved by the executor only. */
  parameter_ref: z.string().nullable(),
  preconditions: z.array(z.string()),
  expected_postcondition: z.string().nullable(),
  policy_decision: z.enum(['allowed', 'denied']),
  risk_class: RiskClass,
  state: z.enum(['persisted', 'dispatched', 'acknowledged', 'effect_observed', 'no_effect', 'failed', 'effect_unknown']),
});
export type ActionIntent = z.infer<typeof ActionIntent>;
