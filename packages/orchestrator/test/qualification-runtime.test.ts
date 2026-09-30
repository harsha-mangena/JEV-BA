import { chmod, mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestConfig, qualify, QualificationRegistry, type CalibrationVersion } from '@qa/calibration';
import { loadPolicy, type Observation, type ScenarioPolicy } from '@qa/contracts';
import { evaluateGate, HEURISTIC_GATE_V0, type GateConfig, type GateInput } from '@qa/gate';
import { NONE, validateResponse, type S1Request } from '@qa/s1';
import { JobWorker, Orchestrator } from '../src/index.ts';

/**
 * Review-3 N3: a calibrated grant held by a running shard honours revocation,
 * expiry, renewal and registry failure at every action, without a restart;
 * other profiles are unaffected.
 */

const ROOT = join(import.meta.dirname, '../../..');
const policy = await loadPolicy(join(ROOT, 'specs/policies/fixture-shop.yaml'));
const scenarioPolicy: ScenarioPolicy = { environments: ['staging'], mutations: ['test_owned_order_create'], external_effects: 'sandbox_only', allowed_origin_profile: 'owned_checkout', unknown_actions: 'deny' };
const observation: Observation = {
  observation_id: 'o1', document_id: 'doc1', page_id: 'p', timestamp: new Date().toISOString(), route: '/cart', title: 'Cart', viewport: { width: 1, height: 1 }, milestones_completed: [], recent_outcomes: [], diagnostics: [], messages: [],
  candidates: [{ node_id: 'n1', role: 'button', name: 'Place order', tag: 'button', visible: true, enabled: true, editable: false, in_viewport: true, supported_operations: ['CLICK'] }],
  coverage: { candidates_total: 1, candidates_included: 1, truncated: false, unsupported_frames: 0, shadow_roots_skipped: 0, extraction_errors: [] },
};
const req: S1Request = { model: 'm', context: '{}', questions: [
  { id: 'op', kind: 'choice', prompt: '', options: ['CLICK', 'TYPE', 'WAIT', 'DONE', 'BLOCKED'].map((k) => ({ key: k, label: k })) },
  { id: 'click_target', kind: 'choice', prompt: '', options: [{ key: 't0', label: '' }, { key: NONE, label: '' }, { key: 'NEED_MORE_CONTEXT', label: '' }] },
] };
const s1 = validateResponse(req, { answers: { op: { probabilities: { CLICK: 0.98, TYPE: 0, WAIT: 0, DONE: 0.02, BLOCKED: 0 } }, click_target: { probabilities: { t0: 0.99, [NONE]: 0.01, NEED_MORE_CONTEXT: 0 } } } });

const config = { model: 'jev-1.13.0', question_schema_version: 'q', extractor_version: 'e', policy_digest: 'p', candidate_filter_version: 'c', gate_version: 'g' };
const band = { threshold: 0.9, accepted: 800, correct: 800, precision: 1, precision_lower: 0.9963, coverage: 0.6, precision_cluster_p05: 0.995 };
const cal = { id: 'cal1', decision_config: config, decision_config_digest: digestConfig(config), threshold: 0.9, target_precision: 0.99, report: { test_band: band, zero_error_samples_needed: 299 } } as unknown as CalibrationVersion;
const profileFor = (environment: string) => ({ project_id: 'shop', environment, application: 'fixture-shop/2', resolved_model: 'jev-1.13.0' });
const DAY = 86_400_000;

function grant(environment: string, checkedAt: Date, now: Date) {
  return qualify(profileFor(environment), { calibration: cal, provider_compat: { ok: true, resolved_model: 'jev-1.13.0', checked_at: checkedAt.toISOString() }, dataset: { source: 'representative', applications: ['fixture-shop/2'], labeled_decisions: 4000, double_label_agreement: 0.95 }, episodes: { attempted: 120, verified_success: 115, false_pass: 0 } }, undefined, now);
}

async function setup(clock: () => Date) {
  const dir = await mkdtemp(join(tmpdir(), 'qa-qual-rt-'));
  const registry = new QualificationRegistry(dir, clock);
  const now = clock();
  const staging = grant('staging', new Date(now.getTime() - DAY), now);
  const preview = grant('preview', new Date(now.getTime() - DAY), now);
  await registry.save(staging);
  await registry.save(preview);
  const calibrated: GateConfig = { ...HEURISTIC_GATE_V0, mode: 'calibrated' as never, calibrated: { version_id: 'cal1', decision_config_digest: cal.decision_config_digest, model: 'jev-1.13.0', threshold: 0.9, score: () => 0.97, supported: () => true, clock } };
  const orch = new Orchestrator({ db: {} as never, suiteBaseDir: ROOT, verifierFor: () => { throw new Error('unused'); }, publisherFor: () => { throw new Error('unused'); }, qualifications: registry });
  const worker = new JobWorker(orch, { outDir: tmpdir(), exploration: { s1: { id: 'x', ask: async () => { throw new Error('unused'); } }, model: 'jev-1.13.0', gate: calibrated } as never });
  const gateFor = (environment: string) => (worker as unknown as { qualifiedGate(p: string, e: string, a: string): Promise<GateConfig> }).qualifiedGate('shop', environment, 'fixture-shop/2');
  return { dir, registry, staging, preview, gateFor };
}

const decide = async (config: GateConfig) =>
  evaluateGate({
    config, identity_verified: true, budget: { actions_remaining: 10, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: false }, environment: 'staging', project_policy: policy, scenario_policy: scenarioPolicy, observation, s1,
    target_keys: { click_target: { t0: 'n1' } }, truncated_heads: [], binding: (op, node) => (op === 'CLICK' && node === 'n1' ? { intent: 'checkout.submit', risk_class: 'test_owned_mutation' } : { risk_class: 'unknown' }),
    freshness: async () => ({ current_document_id: 'doc1', node: { attached: true, visible: true, enabled: true, editable: true } }), recent_no_effect: 0,
    decision_config_digest: cal.decision_config_digest, model: { requested: 'jev-1.13.0', resolved: 'jev-1.13.0' },
  } as GateInput);

describe('calibrated grants at run time (review-3 N3)', () => {
  it('revocation after the first action blocks the next one in the same shard; another profile keeps acting', async () => {
    const t = new Date();
    const { registry, staging, gateFor } = await setup(() => t);
    const shard = await gateFor('staging');
    const other = await gateFor('preview');
    expect((await decide(shard)).outcome).toBe('ACT');
    await registry.revoke(staging.id, 'admin:ops', 'provider incident');
    // The shard's next cases and actions: all refused, without a restart.
    for (let i = 0; i < 3; i++) expect(await decide(shard)).toMatchObject({ outcome: 'ESCALATE', reason_codes: ['qualification_not_current'] });
    expect((await decide(other)).outcome).toBe('ACT');
    // A fresh grant lookup agrees: the shard would start in shadow mode now.
    expect((await gateFor('staging')).mode).toBe('shadow');
  });

  it('a revocation racing concurrent decisions: every decision evaluated after it completes is refused', async () => {
    const t = new Date();
    const { registry, staging, gateFor } = await setup(() => t);
    const shard = await gateFor('staging');
    const revoked = registry.revoke(staging.id, 'admin:ops', 'race');
    const during = await Promise.all(Array.from({ length: 8 }, () => decide(shard)));
    await revoked;
    expect(during.every((d) => d.outcome === 'ACT' || d.reason_codes.includes('qualification_not_current'))).toBe(true);
    const after = await Promise.all(Array.from({ length: 8 }, () => decide(shard)));
    expect(after.map((d) => d.outcome)).toEqual(Array(8).fill('ESCALATE'));
  });

  it('an unreadable registry fails closed', async () => {
    const t = new Date();
    const { dir, gateFor } = await setup(() => t);
    const shard = await gateFor('staging');
    expect((await decide(shard)).outcome).toBe('ACT');
    await rename(dir, `${dir}.moved`);
    expect((await decide(shard)).reason_codes).toEqual(['qualification_not_current']);
    await rename(`${dir}.moved`, dir);
    if (process.getuid?.() !== 0) {
      await chmod(dir, 0o000);
      expect((await decide(shard)).reason_codes).toEqual(['qualification_not_current']);
      await chmod(dir, 0o700);
    }
    expect((await decide(shard)).outcome).toBe('ACT');
  });

  it('expiry during the shard stops it; a renewal of the same qualification reaches the running shard', async () => {
    let now = new Date('2026-10-01T00:00:00Z');
    const { registry, staging, gateFor } = await setup(() => now);
    const shard = await gateFor('staging');
    expect((await decide(shard)).outcome).toBe('ACT');
    now = new Date(Date.parse(staging.expires_at!) + 1);
    expect((await decide(shard)).reason_codes).toEqual(['qualification_not_current']);
    // Renewed with a current probe of the same model: same qualification id, new expiry — the running shard resumes.
    const renewed = await registry.renew(staging.id, { ok: true, resolved_model: 'jev-1.13.0', checked_at: new Date(now.getTime() - 60_000).toISOString() });
    expect(renewed).toMatchObject({ renewed: true });
    expect((await decide(shard)).outcome).toBe('ACT');
    now = new Date(Date.parse((renewed as { record: { expires_at: string } }).record.expires_at));
    expect((await decide(shard)).reason_codes).toEqual(['qualification_not_current']);
  });
});
