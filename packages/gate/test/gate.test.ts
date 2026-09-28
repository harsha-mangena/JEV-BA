import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy, type Observation, type ScenarioPolicy } from '@qa/contracts';
import { NONE, validateResponse, type S1Request } from '@qa/s1';
import { evaluateGate, HEURISTIC_GATE_V0, type GateInput } from '../src/index.ts';

const policy = await loadPolicy(join(import.meta.dirname, '../../../specs/policies/fixture-shop.yaml'));
const scenarioPolicy: ScenarioPolicy = { environments: ['staging'], mutations: ['test_owned_order_create'], external_effects: 'sandbox_only', allowed_origin_profile: 'owned_checkout', unknown_actions: 'deny' };

const observation: Observation = {
  observation_id: 'o1', document_id: 'doc1', page_id: 'p', timestamp: new Date().toISOString(), route: '/cart', title: 'Cart',
  viewport: { width: 1, height: 1 }, milestones_completed: [], recent_outcomes: [], diagnostics: [], messages: [],
  candidates: [
    { node_id: 'n1', role: 'button', name: 'Place order', tag: 'button', visible: true, enabled: true, editable: false, in_viewport: true, supported_operations: ['CLICK'] },
    { node_id: 'n2', role: 'button', name: 'Save cart for later', tag: 'button', visible: true, enabled: true, editable: false, in_viewport: true, supported_operations: ['CLICK'] },
    { node_id: 'n3', role: 'textbox', name: 'Delivery address', tag: 'textarea', visible: true, enabled: true, editable: true, in_viewport: true, supported_operations: ['TYPE'] },
  ],
  coverage: { candidates_total: 3, candidates_included: 3, truncated: false, unsupported_frames: 0, shadow_roots_skipped: 0, extraction_errors: [] },
};

const req: S1Request = {
  model: 'm', context: '{}',
  questions: [
    { id: 'op', kind: 'choice', prompt: '', options: ['CLICK', 'TYPE', 'WAIT', 'DONE', 'BLOCKED'].map((k) => ({ key: k, label: k })) },
    { id: 'click_target', kind: 'choice', prompt: '', options: [{ key: 't0', label: '' }, { key: 't1', label: '' }, { key: NONE, label: '' }, { key: 'NEED_MORE_CONTEXT', label: '' }] },
    { id: 'type_target', kind: 'choice', prompt: '', options: [{ key: 't0', label: '' }, { key: NONE, label: '' }, { key: 'NEED_MORE_CONTEXT', label: '' }] },
    { id: 'type_value', kind: 'choice', prompt: '', options: [{ key: 'fixture.delivery_address', label: '' }, { key: NONE, label: '' }] },
  ],
};

function s1(op: Record<string, number>, click: Record<string, number>, type: Record<string, number> = { t0: 1, [NONE]: 0, NEED_MORE_CONTEXT: 0 }, value: Record<string, number> = { 'fixture.delivery_address': 1, [NONE]: 0 }) {
  const fill = (keys: string[], p: Record<string, number>) => Object.fromEntries(keys.map((k) => [k, p[k] ?? 0]));
  return validateResponse(req, {
    answers: {
      op: { probabilities: fill(['CLICK', 'TYPE', 'WAIT', 'DONE', 'BLOCKED'], op) },
      click_target: { probabilities: fill(['t0', 't1', NONE, 'NEED_MORE_CONTEXT'], click) },
      type_target: { probabilities: fill(['t0', NONE, 'NEED_MORE_CONTEXT'], type) },
      type_value: { probabilities: fill(['fixture.delivery_address', NONE], value) },
    },
  });
}

const fresh = async () => ({ current_document_id: 'doc1', node: { attached: true, visible: true, enabled: true, editable: true } });

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    config: HEURISTIC_GATE_V0,
    identity_verified: true,
    budget: { actions_remaining: 10, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: false },
    environment: 'staging',
    project_policy: policy,
    scenario_policy: scenarioPolicy,
    observation,
    s1: s1({ CLICK: 0.97, DONE: 0.03 }, { t0: 0.95, t1: 0.05 }),
    target_keys: { click_target: { t0: 'n1', t1: 'n2' }, type_target: { t0: 'n3' } },
    truncated_heads: [],
    binding: (op, node) => (op === 'CLICK' && node === 'n1' ? { intent: 'checkout.submit', risk_class: 'test_owned_mutation' } : op === 'TYPE' ? { risk_class: 'reversible_input' } : { risk_class: 'unknown' }),
    freshness: fresh,
    recent_no_effect: 0,
    ...over,
  };
}

describe('gate ordering', () => {
  it('acts on a permitted, fresh, confident decision and labels the gate heuristic', async () => {
    const d = await evaluateGate(input());
    expect(d).toMatchObject({ outcome: 'ACT', op: 'CLICK', node_id: 'n1' });
    expect(d.reason_codes).toContain('heuristic_gate_uncalibrated');
    expect(d.features!.pair_score).toBeCloseTo(0.97 * 0.95);
  });

  it('denies a forbidden mutation even with perfect scores', async () => {
    const d = await evaluateGate(input({ s1: s1({ CLICK: 1 }, { t0: 1 }), scenario_policy: { ...scenarioPolicy, mutations: [] } }));
    expect(d).toMatchObject({ outcome: 'DENY', reason_codes: ['mutation_not_authorized'] });
    const prod = await evaluateGate(input({ s1: s1({ CLICK: 1 }, { t0: 1 }), environment: 'production' }));
    expect(prod.outcome).toBe('DENY');
  });

  it('denies unknown action semantics regardless of scenario opt-outs (audit F02b)', async () => {
    const pick2 = s1({ CLICK: 1 }, { t1: 1 });
    const d = await evaluateGate(input({ s1: pick2 }));
    expect(d.outcome).toBe('DENY');
    expect(d.reason_codes).toEqual(expect.arrayContaining(['unknown_action_semantics']));
    // `read_only_exploration` used to turn an unknown effect into ACT; unknown effects are now always denied.
    const optOut = await evaluateGate(input({ s1: pick2, scenario_policy: { ...scenarioPolicy, unknown_actions: 'read_only_exploration' } }));
    expect(optOut.outcome).toBe('DENY');
    expect(optOut.reason_codes).toEqual(expect.arrayContaining(['unknown_action_semantics']));
  });

  it('denies before anything else when identity is unverified', async () => {
    expect((await evaluateGate(input({ identity_verified: false }))).outcome).toBe('DENY');
  });

  it('re-observes a stale node rather than acting', async () => {
    const d = await evaluateGate(input({ freshness: async () => ({ current_document_id: 'doc2', node: null }) }));
    expect(d).toMatchObject({ outcome: 'REOBSERVE', reason_codes: ['stale_observation'] });
    const out = await evaluateGate(input({ freshness: async () => ({ current_document_id: 'doc2', node: null }), budget: { actions_remaining: 5, reobservations_remaining: 0, s2_remaining: 1, deadline_passed: false } }));
    expect(out.outcome).toBe('ABSTAIN');
  });

  it('escalates the plan §3.2 checkout example (0.93 op, 0.48 vs 0.44 target)', async () => {
    const d = await evaluateGate(input({ s1: s1({ CLICK: 0.93, DONE: 0.07 }, { t0: 0.48, t1: 0.44, NEED_MORE_CONTEXT: 0.08 }) }));
    expect(d.outcome).toBe('ESCALATE');
    expect(d.reason_codes).toEqual(expect.arrayContaining(['target_uncertain', 'target_margin_low']));
    expect(d.features!.pair_score).toBeCloseTo(0.4464);
    const noS2 = await evaluateGate(input({ s1: s1({ CLICK: 0.93, DONE: 0.07 }, { t0: 0.48, t1: 0.44, NEED_MORE_CONTEXT: 0.08 }), budget: { actions_remaining: 5, reobservations_remaining: 2, s2_remaining: 0, deadline_passed: false } }));
    expect(noS2.outcome).toBe('ABSTAIN');
  });

  it('a pair threshold of 0.95 cannot be met with op 0.93, however confident the target', async () => {
    const d = await evaluateGate(input({ config: { ...HEURISTIC_GATE_V0, min_pair_score: 0.95 }, s1: s1({ CLICK: 0.93, DONE: 0.07 }, { t0: 1 }) }));
    expect(d.reason_codes).toContain('pair_score_low');
    expect(d.outcome).toBe('ESCALATE');
  });

  it('routes NONE to escalation or context acquisition, never to action', async () => {
    const d = await evaluateGate(input({ s1: s1({ CLICK: 1 }, { [NONE]: 0.9, t0: 0.1 }) }));
    expect(d).toMatchObject({ outcome: 'ESCALATE', reason_codes: ['target_absent'] });
    const trunc = await evaluateGate(input({ s1: s1({ CLICK: 1 }, { [NONE]: 0.9, t0: 0.1 }), truncated_heads: ['click_target'], budget: { actions_remaining: 5, reobservations_remaining: 2, s2_remaining: 0, deadline_passed: false } }));
    expect(trunc).toMatchObject({ outcome: 'REOBSERVE' });
  });

  it('abstains on a malformed selected head and never falls back to another head', async () => {
    const bad = validateResponse(req, { answers: { op: { probabilities: { CLICK: Number.NaN } } } } as never);
    expect((await evaluateGate(input({ s1: bad }))).outcome).toBe('ABSTAIN');
  });

  it('requires a valid fixture parameter for TYPE', async () => {
    const ok = await evaluateGate(input({ s1: s1({ TYPE: 1 }, { t0: 1 }) }));
    expect(ok).toMatchObject({ outcome: 'ACT', op: 'TYPE', node_id: 'n3', parameter_ref: 'fixture.delivery_address' });
    const none = await evaluateGate(input({ s1: s1({ TYPE: 1 }, { t0: 1 }, undefined, { [NONE]: 1 }) }));
    expect(none.reason_codes).toEqual(['no_valid_parameter']);
  });

  it('stops acting after repeated no-effect outcomes and when budgets run out', async () => {
    expect((await evaluateGate(input({ recent_no_effect: 3 }))).reason_codes).toEqual(['loop_no_effect']);
    expect((await evaluateGate(input({ budget: { actions_remaining: 0, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: false } }))).outcome).toBe('ABSTAIN');
    expect((await evaluateGate(input({ budget: { actions_remaining: 5, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: true } }))).outcome).toBe('ABSTAIN');
  });

  it('lets an S2 selection re-enter permission and freshness checks without an uncertainty upgrade', async () => {
    const uncertain = s1({ CLICK: 0.93, DONE: 0.07 }, { t0: 0.48, t1: 0.44, NEED_MORE_CONTEXT: 0.08 });
    const ok = await evaluateGate(input({ s1: uncertain, s2_selection: { op: 'CLICK', node_id: 'n1' } }));
    expect(ok).toMatchObject({ outcome: 'ACT', node_id: 'n1' });
    expect(ok.reason_codes).toContain('s2_selected_uncalibrated');
    const forbidden = await evaluateGate(input({ s1: uncertain, s2_selection: { op: 'CLICK', node_id: 'n1' }, scenario_policy: { ...scenarioPolicy, mutations: [] } }));
    expect(forbidden.outcome).toBe('DENY');
    const stale = await evaluateGate(input({ s1: uncertain, s2_selection: { op: 'CLICK', node_id: 'n1' }, freshness: async () => ({ current_document_id: 'other', node: null }) }));
    expect(stale.outcome).toBe('REOBSERVE');
    const typeOnButton = await evaluateGate(input({ s1: uncertain, s2_selection: { op: 'TYPE', node_id: 'n1' } }));
    expect(typeOnButton.reason_codes).toEqual(['s2_target_not_eligible']);
  });

  it('uses a calibrated scorer only for the exact decision configuration and supported cohorts', async () => {
    const calibrated = { version_id: 'cal_1', decision_config_digest: 'cfg', threshold: 0.9, score: () => 0.95, supported: (f: { risk_class: string }) => f.risk_class === 'test_owned_mutation' };
    const config = { ...HEURISTIC_GATE_V0, calibrated };
    const act = await evaluateGate(input({ config, decision_config_digest: 'cfg' }));
    expect(act).toMatchObject({ outcome: 'ACT' });
    expect(act.reason_codes).toContain('calibrated:cal_1');
    const low = await evaluateGate(input({ config: { ...config, calibrated: { ...calibrated, score: () => 0.5 } }, decision_config_digest: 'cfg' }));
    expect(low).toMatchObject({ outcome: 'ESCALATE', reason_codes: ['calibrated_score_low'] });
    const cohort = await evaluateGate(input({ config: { ...config, calibrated: { ...calibrated, supported: () => false } }, decision_config_digest: 'cfg' }));
    expect(cohort.reason_codes).toEqual(['cohort_uncalibrated']);
    // Changed model/prompt/extractor: calibration does not apply; heuristic routing, flagged.
    const stale = await evaluateGate(input({ config, decision_config_digest: 'other' }));
    expect(stale.reason_codes).toEqual(expect.arrayContaining(['calibration_config_mismatch', 'heuristic_gate_uncalibrated']));
    // Calibration never overrides permission.
    const forbidden = await evaluateGate(input({ config, decision_config_digest: 'cfg', scenario_policy: { ...scenarioPolicy, mutations: [] } }));
    expect(forbidden.outcome).toBe('DENY');
  });

  it('handles WAIT and BLOCKED without a target', async () => {
    expect((await evaluateGate(input({ s1: s1({ WAIT: 1 }, { t0: 1 }) }))).outcome).toBe('REOBSERVE');
    expect((await evaluateGate(input({ s1: s1({ BLOCKED: 1 }, { t0: 1 }) }))).outcome).toBe('ABSTAIN');
  });
});
