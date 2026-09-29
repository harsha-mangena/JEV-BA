import {
  authorizeIntent,
  type AuthorizationDecision,
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
/**
 * Autonomy mode (audit F04):
 *  - `shadow`: decisions are computed and recorded but never executed;
 *  - `heuristic_staging`: uncalibrated thresholds may act, outside production only,
 *    and every such action is labelled uncalibrated;
 *  - `calibrated`: only a fitted scorer whose decision configuration (including the
 *    *resolved* model) matches exactly may act; anything else routes, never acts.
 * A configuration that claims calibration (`heuristic: false` or a scorer) is always
 * `calibrated`, whatever else it says, so a stale or unqualified calibration can never
 * fall back to heuristic action.
 */
export type AutonomyMode = 'shadow' | 'heuristic_staging' | 'calibrated';

export interface GateConfig {
  version: string;
  calibration_version: string | null;
  heuristic: boolean;
  mode?: AutonomyMode;
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
    model?: string;
    threshold: number;
    score(f: GateFeatures): number;
    supported(f: GateFeatures): boolean;
    /**
     * End of the qualification that authorizes this calibration (re-audit R5).
     * Checked at every decision, so a long-running worker stops acting the
     * moment its authorization expires.
     */
    authorized_until?: string | null;
    /** Clock for `authorized_until` (tests); defaults to the system clock. */
    clock?: () => Date;
  };
}

export const HEURISTIC_GATE_V0: GateConfig = {
  version: 'heuristic-v0',
  calibration_version: null,
  heuristic: true,
  mode: 'heuristic_staging',
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
  /**
   * Shared authorization service for the proposed action. `parameterRef`
   * undefined = check the effect only (stage 2); a value = full check incl.
   * parameter association (stage 3).
   */
  authorize?: (op: Operation, nodeId: string | null, parameterRef?: string | null) => AuthorizationDecision;
  /** @deprecated trusted binding lookup; used only when `authorize` is absent. Unknown effects are always denied. */
  binding?: (op: Operation, nodeId: string | null) => ActionBinding;
  freshness: (nodeId: string) => Promise<Freshness>;
  recent_no_effect: number;
  /**
   * An S2 selection re-enters stages 1-4 (identity, permission, parameter,
   * freshness) but not the S1 uncertainty stage: it is a typed proposal, not a
   * probability, and does not turn an uncertain decision into a certain one.
   */
  s2_selection?: { op: Operation; node_id: string };
  /** Digest of the *resolved* model, question schema, extractor, policy, candidate filter and gate versions in use. */
  decision_config_digest?: string;
  /** Model identity for this decision; calibrated autonomy requires a resolved model. */
  model?: { requested: string; resolved: string | null };
}

export function autonomyMode(c: GateConfig): AutonomyMode {
  if (c.mode === 'shadow') return 'shadow';
  if (c.calibrated || !c.heuristic || c.calibration_version !== null) return 'calibrated';
  return 'heuristic_staging';
}

/** Environments in which uncalibrated (heuristic) autonomy may act. */
const HEURISTIC_FORBIDDEN_ENVIRONMENTS = new Set(['production', 'prod']);

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

  // 2. Permission, independent of any score. Unknown effects are denied; there is no opt-out.
  const authorize = g.authorize ?? legacyAuthorize(g);
  const effectAuth = authorize(op, nodeId);
  if (!effectAuth.allowed) return deny('DENY', [effectAuth.code, ...(effectAuth.code === 'unknown_effect' ? ['unknown_action_semantics'] : [])], { op, node_id: nodeId });

  // 3. Parameter resolution (and its association with the control) and candidate coverage.
  let parameterRef: string | null = null;
  if (op === 'TYPE') {
    const v = g.s1.answers.type_value;
    if (!v || v.selected === NONE) return deny(g.budget.s2_remaining > 0 ? 'ESCALATE' : 'ABSTAIN', ['no_valid_parameter'], { op, node_id: nodeId });
    parameterRef = v.selected;
    const full = authorize(op, nodeId, parameterRef);
    if (!full.allowed) return deny('DENY', [full.code], { op, node_id: nodeId });
  }
  const binding = { risk_class: effectAuth.risk_class };
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
  const c = g.config;
  const mode = autonomyMode(c);
  const routeOrAbstain = (why: string[]): GateDecision => ({ outcome: g.budget.s2_remaining > 0 && !g.s2_selection ? 'ESCALATE' : 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: why, features });
  const heuristicBlocked = HEURISTIC_FORBIDDEN_ENVIRONMENTS.has(g.environment);

  if (g.s2_selection) {
    // A typed S2 proposal is not a calibrated probability: it may act only where heuristic autonomy may.
    if (mode === 'shadow') return { outcome: 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 'shadow_mode', 'shadow_would_act'], features };
    if (mode === 'calibrated') return { outcome: 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 's2_selection_uncalibrated'], features };
    if (heuristicBlocked) return { outcome: 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 'heuristic_not_permitted_in_environment'], features };
    return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 's2_selected_uncalibrated'], features };
  }

  if (mode === 'calibrated') {
    const cal = c.calibrated;
    if (!cal) return routeOrAbstain([...reasons, c.calibration_version ? 'calibration_unqualified' : 'calibration_missing']);
    if (cal.authorized_until !== undefined) {
      const until = cal.authorized_until === null ? NaN : Date.parse(cal.authorized_until);
      if (!Number.isFinite(until) || (cal.clock?.() ?? new Date()).getTime() >= until) return routeOrAbstain([...reasons, 'qualification_expired']);
    }
    if (!g.model?.resolved) return routeOrAbstain([...reasons, 'resolved_model_unknown']);
    if (g.decision_config_digest !== cal.decision_config_digest) return routeOrAbstain([...reasons, 'calibration_config_mismatch']);
    if (!cal.supported(features)) reasons.push('cohort_uncalibrated');
    else if (cal.score(features) < cal.threshold) reasons.push('calibrated_score_low');
    if (reasons.some((r) => r !== 'candidates_truncated')) return routeOrAbstain(reasons);
    return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, `calibrated:${cal.version_id}`], features };
  }

  // Heuristic routing (staging or shadow): thresholds route decisions but establish no precision guarantee.
  if (features.op_probability < c.min_op_probability) reasons.push('op_uncertain');
  if (targetAnswer) {
    if (targetAnswer.top.p < c.min_target_probability) reasons.push('target_uncertain');
    if (targetAnswer.margin < c.min_target_margin) reasons.push('target_margin_low');
    if (c.min_pair_score !== undefined && features.pair_score! < c.min_pair_score) reasons.push('pair_score_low');
  }
  const uncertain = reasons.some((r) => r !== 'candidates_truncated');
  if (uncertain) return routeOrAbstain(reasons);
  if (mode === 'shadow') return { outcome: 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 'shadow_mode', 'shadow_would_act'], features };
  if (heuristicBlocked) return { outcome: 'ABSTAIN', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: [...reasons, 'heuristic_not_permitted_in_environment'], features };
  reasons.push('heuristic_gate_uncalibrated');
  return { outcome: 'ACT', op, node_id: nodeId, parameter_ref: parameterRef, reason_codes: reasons, features };
}

/** Compatibility for callers that still supply a role/name `binding`: same fail-closed semantics. */
function legacyAuthorize(g: GateInput): (op: Operation, nodeId: string | null, parameterRef?: string | null) => AuthorizationDecision {
  return (op, nodeId) => {
    if (!isTargeted(op)) return { allowed: true, effect: 'none', intent: null, mutation: null, risk_class: 'read_only', binding: null };
    const b = g.binding?.(op, nodeId) ?? { risk_class: 'unknown' as const };
    if (b.risk_class === 'unknown') return { allowed: false, code: 'unknown_effect', reason: 'no trusted binding', effect: 'unknown', intent: null };
    if (b.risk_class === 'external_effect' && g.scenario_policy.external_effects !== 'sandbox_only') return { allowed: false, code: 'external_effect_not_permitted', reason: 'external effect', effect: 'external', intent: b.intent ?? null };
    if (b.risk_class === 'test_owned_mutation' && !b.intent) return { allowed: false, code: 'missing_intent', reason: 'mutation without intent binding', effect: 'mutation', intent: null };
    if (b.intent) {
      const a = authorizeIntent(g.project_policy, g.scenario_policy.mutations, g.environment, b.intent);
      if (!a.allowed) return { allowed: false, code: 'mutation_not_authorized', reason: a.reason, effect: 'mutation', intent: b.intent };
      return { allowed: true, effect: a.mutation ? 'mutation' : 'none', intent: b.intent, mutation: a.mutation ?? null, risk_class: b.risk_class, binding: null };
    }
    return { allowed: true, effect: 'none', intent: null, mutation: null, risk_class: b.risk_class, binding: null };
  };
}
