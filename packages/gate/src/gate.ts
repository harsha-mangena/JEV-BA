import {
  authorizeIntent,
  isTargeted,
  type GateFeatures,
  type GateOutcome,
  type Observation,
  type Operation,
  type ProjectPolicy,
  type RiskClass,
  type ScenarioPolicy,
} from '@qa/contracts';
import { NEED_MORE_CONTEXT, NONE, TARGET_HEAD, type ValidAnswer, type ValidationOutcome } from '@qa/s1';

/**
 * Uncertainty-routing configuration. Until a calibrator has been fitted on
 * held-out labeled data, thresholds are *heuristic* settings: they route
 * decisions but establish no precision guarantee.
 */
export interface GateConfig {
  version: string;
  calibration_version: string | null;
  heuristic: boolean;
  min_op_probability: number;
  min_target_probability: number;
  min_target_margin: number;
  /** Optional; pair_score is an uncalibrated product, not a joint probability. */
  min_pair_score?: number;
  /** Consecutive no-effect outcomes before the loop detector stops acting. */
  max_recent_no_effect: number;
  /** Fitted stage-5 scorer (Phase 8). Applies only to the exact decision configuration it was fitted on. */
  calibrated?: {
    version_id: string;
    decision_config_digest: string;
    threshold: number;
    score(f: GateFeatures): number;
    supported(f: GateFeatures): boolean;
  };
}

export const HEURISTIC_GATE_V0: GateConfig = {
  version: 'heuristic-v0',
  calibration_version: null,
  heuristic: true,
  min_op_probability: 0.8,
  min_target_probability: 0.8,
  min_target_margin: 0.2,
  max_recent_no_effect: 3,
};

/** Controller-resolved semantics for the proposed action. Derived from trusted bindings, never from the model. */
export interface ActionBinding {
  intent?: string;
  risk_class: RiskClass;
}

export interface Freshness {
  /** Current document id; differs from the observation's after navigation. */
  current_document_id: string;
  node: { attached: boolean; visible: boolean; enabled: boolean; editable: boolean } | null;
}

export interface GateInput {
  config: GateConfig;
  identity_verified: boolean;
  budget: { actions_remaining: number; reobservations_remaining: number; s2_remaining: number; deadline_passed: boolean };
  environment: string;
  project_policy: ProjectPolicy;
  scenario_policy: ScenarioPolicy;
  observation: Observation;
  s1: ValidationOutcome;
  target_keys: Record<string, Record<string, string>>;
  truncated_heads: string[];
  binding: (op: Operation, nodeId: string | null) => ActionBinding;
  freshness: (nodeId: string) => Promise<Freshness>;
  recent_no_effect: number;
  /**
   * An S2 selection re-enters stages 1-4 (identity, permission, parameter,
   * freshness) but not the S1 uncertainty stage: it is a typed proposal, not a
   * probability, and does not turn an uncertain decision into a certain one.
   */
  s2_selection?: { op: Operation; node_id: string };
  /** Digest of model, question schema, extractor, policy, candidate filter and gate versions in use. */
  decision_config_digest?: string;
}

export interface GateDecision {
  outcome: GateOutcome;
  op: Operation | null;
  node_id: string | null;
  parameter_ref: string | null;
  reason_codes: string[];
  features: GateFeatures | null;
}

const margin = (a: ValidAnswer) => a.margin;

/**
 * Mandatory ordering (plan §6.3):
 *  1. identity / budget / schema
 *  2. permission, independent of scores
 *  3. target + parameter resolution, candidate coverage
 *  4. freshness and actionability
 *  5. uncertainty
 * A perfect score cannot pass a step that an earlier stage rejected.
 */
export async function evaluateGate(g: GateInput): Promise<GateDecision> {
  const deny = (outcome: GateOutcome, reasons: string[], extra: Partial<GateDecision> = {}): GateDecision => ({ outcome, op: null, node_id: null, parameter_ref: null, reason_codes: reasons, features: null, ...extra });

  // 1. Identity, budget and response schema.
  if (!g.identity_verified) return deny('DENY', ['identity_unverified']);
  if (g.budget.deadline_passed) return deny('ABSTAIN', ['deadline_exceeded']);
  if (g.budget.actions_remaining <= 0) return deny('ABSTAIN', ['action_budget_exhausted']);
  const opAnswer = g.s1.answers.op;
  if (!opAnswer) return deny('ABSTAIN', [`invalid_op_head:${g.s1.invalid.op ?? 'missing'}`]);
  const op = g.s2_selection?.op ?? (opAnswer.selected as Operation);

  if (op === 'WAIT') return deny(g.budget.reobservations_remaining > 0 ? 'REOBSERVE' : 'ABSTAIN', ['model_requested_wait'], { op });
  if (op === 'BLOCKED') return deny('ABSTAIN', ['model_reported_blocked'], { op });

  let nodeId: string | null = null;
  let targetAnswer: ValidAnswer | null = null;
  const reasons: string[] = [];
  if (g.s2_selection) {
    if (!g.observation.candidates.some((c) => c.node_id === g.s2_selection!.node_id && c.supported_operations.includes(op))) {
      return deny('ABSTAIN', ['s2_target_not_eligible'], { op });
    }
    nodeId = g.s2_selection.node_id;
  } else if (isTargeted(op)) {
    const head = TARGET_HEAD[op];
    targetAnswer = g.s1.answers[head] ?? null;
    if (!targetAnswer) return deny('ABSTAIN', [`invalid_target_head:${g.s1.invalid[head] ?? 'missing'}`], { op });
    const key = targetAnswer.selected;
    if (key === NONE || key === NEED_MORE_CONTEXT) {
      const more = g.truncated_heads.includes(head) || g.observation.coverage.truncated;
      const outcome: GateOutcome = g.budget.s2_remaining > 0 ? 'ESCALATE' : g.budget.reobservations_remaining > 0 && more ? 'REOBSERVE' : 'ABSTAIN';
      return deny(outcome, [key === NONE ? 'target_absent' : 'needs_more_context', ...(more ? ['candidates_truncated'] : [])], { op });
    }
    nodeId = g.target_keys[head]?.[key] ?? null;
    if (!nodeId) return deny('ABSTAIN', ['target_key_unresolved'], { op });
  }

  // 2. Permission, independent of any score.
  const binding = g.binding(op, nodeId);
  if (binding.risk_class === 'external_effect' && g.scenario_policy.external_effects !== 'sandbox_only') return deny('DENY', ['external_effect_not_permitted'], { op, node_id: nodeId });
  if (binding.risk_class === 'unknown' && g.scenario_policy.unknown_actions === 'deny') return deny('DENY', ['unknown_action_semantics'], { op, node_id: nodeId });
  if (binding.intent) {
    const auth = authorizeIntent(g.project_policy, g.scenario_policy.mutations, g.environment, binding.intent);
    if (!auth.allowed) return deny('DENY', ['mutation_not_authorized'], { op, node_id: nodeId });
  } else if (binding.risk_class === 'test_owned_mutation') {
    return deny('DENY', ['mutation_without_intent_binding'], { op, node_id: nodeId });
  }

  // 3. Parameter resolution and candidate coverage.
  let parameterRef: string | null = null;
  if (op === 'TYPE') {
    const v = g.s1.answers.type_value;
    if (!v || v.selected === NONE) return deny(g.budget.s2_remaining > 0 ? 'ESCALATE' : 'ABSTAIN', ['no_valid_parameter'], { op, node_id: nodeId });
    parameterRef = v.selected;
  }
  if (isTargeted(op) && g.truncated_heads.includes(TARGET_HEAD[op])) reasons.push('candidates_truncated');

  // 4. Freshness and actionability.
  let fresh = true;
  if (nodeId) {
    const f = await g.freshness(nodeId);
    const stale = f.current_document_id !== g.observation.document_id || !f.node || !f.node.attached;
    const unactionable = !stale && (!f.node!.visible || !f.node!.enabled || (op === 'TYPE' && !f.node!.editable));
    if (stale || unactionable) {
      fresh = false;
      return deny(g.budget.reobservations_remaining > 0 ? 'REOBSERVE' : 'ABSTAIN', [stale ? 'stale_observation' : 'target_not_actionable'], { op, node_id: nodeId });
    }
  }

  // 5. Uncertainty.
  const features: GateFeatures = {
    op,
    op_probability: opAnswer.top.p,
    op_margin: margin(opAnswer),
    target_probability: targetAnswer?.top.p ?? null,
    target_margin: targetAnswer ? margin(targetAnswer) : null,
    pair_score: targetAnswer ? opAnswer.top.p * targetAnswer.top.p : null,
    provider_confidence: opAnswer.confidence,
    candidate_count: g.observation.candidates.length,
    candidates_truncated: g.observation.coverage.truncated,
    argument_valid: op !== 'TYPE' || parameterRef !== null,
    fresh,
    risk_class: binding.risk_class,
    recent_no_effect: g.recent_no_effect,
  };
  if (g.recent_no_effect >= g.config.max_recent_no_effect) return deny('ABSTAIN', ['loop_no_effect'], { op, node_id: nodeId, features });
  if (g.s2_selection) return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 's2_selected_uncalibrated'], features };
  const c = g.config;
  const cal = c.calibrated;
  if (cal && g.decision_config_digest === cal.decision_config_digest) {
    if (!cal.supported(features)) reasons.push('cohort_uncalibrated');
    else if (cal.score(features) < cal.threshold) reasons.push('calibrated_score_low');
    if (reasons.some((r) => r !== 'candidates_truncated')) return { outcome: g.budget.s2_remaining > 0 ? 'ESCALATE' : 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: reasons, features };
    return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, `calibrated:${cal.version_id}`], features };
  }
  // No calibration for this exact configuration: heuristic routing, labelled as such.
  if (cal) reasons.push('calibration_config_mismatch');
  if (features.op_probability < c.min_op_probability) reasons.push('op_uncertain');
  if (targetAnswer) {
    if (targetAnswer.top.p < c.min_target_probability) reasons.push('target_uncertain');
    if (targetAnswer.margin < c.min_target_margin) reasons.push('target_margin_low');
    if (c.min_pair_score !== undefined && features.pair_score! < c.min_pair_score) reasons.push('pair_score_low');
  }
  const uncertain = reasons.some((r) => r !== 'candidates_truncated' && r !== 'calibration_config_mismatch');
  if (uncertain) {
    const outcome: GateOutcome = g.budget.s2_remaining > 0 ? 'ESCALATE' : 'ABSTAIN';
    return { outcome, op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: reasons, features };
  }
  if (c.heuristic) reasons.push('heuristic_gate_uncalibrated');
  return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: reasons, features };
}
