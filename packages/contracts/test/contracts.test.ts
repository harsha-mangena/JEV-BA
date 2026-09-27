import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authorizeIntent,
  canTransition,
  combineAttempts,
  ContractError,
  DeploymentEnvelope,
  evaluateReleaseGate,
  executionDedupKey,
  loadFixtureCatalog,
  loadPolicy,
  loadScenario,
  manifestMatchesEnvelope,
  parseWith,
  resolveAllowedOrigins,
  Scenario,
  type ScenarioInput,
  validateScenarioSemantics,
} from '../src/index.ts';

const SPECS = join(import.meta.dirname, '../../../specs');
const catalog = await loadFixtureCatalog(join(SPECS, 'fixtures.yaml'));
const policy = await loadPolicy(join(SPECS, 'policies/fixture-shop.yaml'));

function baseScenario(): ScenarioInput {
  return {
    schema_version: 1,
    id: 'tmp',
    requirement_ids: ['TMP-01'],
    mode: 'regression',
    start_path: '/cart',
    fixture: 'customer_cart_one_item_v1',
    role: 'customer',
    goal: 'x',
    milestones: [{ id: 'm', assertions: [{ type: 'ui_visible', target: 'order-confirmation' }] }],
    execution_profiles: ['chromium_desktop'],
    policy: { environments: ['staging'], external_effects: 'none', allowed_origin_profile: 'owned_app' },
    cleanup: 'delete_test_owned_entities',
  };
}
const semantic = (input: ScenarioInput) => validateScenarioSemantics(parseWith(Scenario, input, 'test'), catalog, policy);

describe('shipped specs', () => {
  for (const dir of ['scenarios', 'exploration']) {
    it(`every ${dir} spec parses and resolves`, async () => {
      const files = (await readdir(join(SPECS, dir))).filter((f) => f.endsWith('.yaml'));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const s = await loadScenario(join(SPECS, dir, f));
        expect(validateScenarioSemantics(s, catalog, policy), f).toEqual([]);
        expect(`${s.id}.yaml`).toBe(f);
      }
    });
  }
});

describe('scenario schema', () => {
  it('rejects a milestone with an empty assertion list', () => {
    const s = baseScenario();
    s.milestones = [{ id: 'm', assertions: [] }];
    expect(() => parseWith(Scenario, s, 't')).toThrow(/at least one assertion/);
  });

  it('rejects a scenario with no milestones', () => {
    const s = baseScenario();
    s.milestones = [];
    expect(() => parseWith(Scenario, s, 't')).toThrow(ContractError);
  });

  it('requires exactly one of value/value_ref', () => {
    const s = baseScenario();
    s.milestones[0]!.steps = [{ op: 'type', target: 'x', value: 'a', value_ref: 'fixture.email' }];
    expect(() => parseWith(Scenario, s, 't')).toThrow(/exactly one of value, value_ref/);
  });

  it('rejects unknown keys (typos never silently weaken a contract)', () => {
    const s = baseScenario() as Record<string, unknown>;
    s.assertionz = [];
    expect(() => parseWith(Scenario, s, 't')).toThrow(/Unrecognized key/);
  });

  it('normalizes a bare string target to a test id', () => {
    const s = parseWith(Scenario, baseScenario(), 't');
    expect(s.milestones[0]!.assertions[0]).toEqual({ type: 'ui_visible', target: { testid: 'order-confirmation' } });
  });
});

describe('scenario semantics', () => {
  it('rejects an unresolved fixture reference', () => {
    const s = baseScenario();
    s.milestones[0]!.assertions.push({ type: 'order_count_delta', customer_ref: 'fixture.nope', equals: 1 });
    expect(semantic(s).map((i) => i.message)).toContain('fixture.nope does not resolve in fixture customer_cart_one_item_v1');
  });

  it('rejects an unknown fixture and role mismatch', () => {
    const s = baseScenario();
    s.fixture = 'nope';
    expect(semantic(s)[0]!.message).toMatch(/unknown fixture/);
    const t = baseScenario();
    t.role = 'admin';
    expect(semantic(t)[0]!.message).toMatch(/provisions role customer/);
  });

  it('rejects an unknown origin profile and environment', () => {
    const s = baseScenario();
    s.policy.allowed_origin_profile = 'somewhere_else';
    s.policy.environments = ['mars'];
    const msgs = semantic(s).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/unknown origin profile/);
    expect(msgs).toMatch(/environment mars is not configured/);
  });

  it('forbids secret references in assertions', () => {
    const s = baseScenario();
    s.milestones[0]!.assertions.push({ type: 'ui_text', target: 'x', equals_ref: 'secret.password' });
    expect(semantic(s)[0]!.message).toMatch(/secret reference .* not allowed/);
  });

  it('allows secret references in typed input', () => {
    const s = baseScenario();
    s.milestones[0]!.steps = [{ op: 'type', target: { label: 'Password' }, value_ref: 'secret.password' }];
    expect(semantic(s)).toEqual([]);
  });

  it('rejects a mutating intent the scenario does not authorize', () => {
    const s = baseScenario();
    s.milestones[0]!.steps = [{ op: 'click', target: 'place-order', intent: 'checkout.submit' }];
    expect(semantic(s)[0]!.message).toMatch(/not authorized/);
  });

  it('rejects scripted steps in exploration mode', () => {
    const s = baseScenario();
    s.mode = 'exploration';
    s.milestones[0]!.steps = [{ op: 'reload' }];
    expect(semantic(s)[0]!.message).toMatch(/must not script steps/);
  });
});

describe('policy', () => {
  it('authorizes a bound intent only with scenario mutation and environment', () => {
    expect(authorizeIntent(policy, ['test_owned_order_create'], 'staging', 'checkout.submit')).toEqual({ allowed: true, mutation: 'test_owned_order_create' });
    expect(authorizeIntent(policy, [], 'staging', 'checkout.submit').allowed).toBe(false);
    expect(authorizeIntent(policy, ['test_owned_order_create'], 'production', 'checkout.submit').allowed).toBe(false);
    expect(authorizeIntent(policy, [], 'staging', undefined).allowed).toBe(true);
  });

  it('substitutes the candidate origin', () => {
    expect([...resolveAllowedOrigins(policy, 'owned_app', 'https://pr-1.example.dev')]).toEqual(['https://pr-1.example.dev']);
    expect(() => resolveAllowedOrigins(policy, 'missing', 'https://x.dev')).toThrow();
  });
});

describe('run lifecycle and verdicts', () => {
  it('only moves forward or into a terminal failure state', () => {
    expect(canTransition('RECEIVED', 'VALIDATING')).toBe(true);
    expect(canTransition('RECEIVED', 'RUNNING')).toBe(false);
    expect(canTransition('RUNNING', 'SUPERSEDED')).toBe(true);
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('CANCELLED', 'ERROR')).toBe(false);
  });

  it('preserves a first failure as FLAKY', () => {
    expect(combineAttempts(['FAIL', 'PASS'])).toBe('FLAKY');
    expect(combineAttempts(['PASS'])).toBe('PASS');
    expect(combineAttempts(['PASS', 'FAIL'])).toBe('FAIL');
    expect(combineAttempts([])).toBe('ERROR');
  });

  const expected = [
    { scenario_id: 'a', execution_profile: 'd' },
    { scenario_id: 'b', execution_profile: 'd' },
  ];
  const pass = (id: string, extra: Partial<{ verdict: 'PASS' | 'FLAKY' | 'NEEDS_REVIEW' | 'BLOCKED'; critical: boolean; required: boolean }> = {}) => ({
    scenario_id: id,
    execution_profile: 'd',
    verdict: 'PASS' as const,
    critical: false,
    required: true,
    ...extra,
  });

  it('a missing shard never produces a green gate', () => {
    expect(evaluateReleaseGate(expected, [pass('a')])).toEqual({ eligible: false, reasons: ['b@d: missing result'] });
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b')]).eligible).toBe(true);
    expect(evaluateReleaseGate([], []).eligible).toBe(false);
  });

  it('holds on BLOCKED, critical FLAKY and required NEEDS_REVIEW', () => {
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b', { verdict: 'BLOCKED' })]).eligible).toBe(false);
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b', { verdict: 'FLAKY', critical: true })]).eligible).toBe(false);
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b', { verdict: 'FLAKY' })]).eligible).toBe(true);
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b', { verdict: 'NEEDS_REVIEW', required: false })]).eligible).toBe(true);
  });

  it('rejects duplicate or unexpected results', () => {
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b'), pass('b')]).eligible).toBe(false);
    expect(evaluateReleaseGate(expected, [pass('a'), pass('b'), pass('c')]).eligible).toBe(false);
  });
});

describe('deployment identity', () => {
  const env = parseWith(
    DeploymentEnvelope,
    {
      schema_version: 1,
      tenant_id: 't',
      project_id: 'p',
      repository_id: 42,
      provider: 'github',
      delivery_id: 'd1',
      deployment_id: '99',
      environment: 'preview',
      immutable_url: 'https://pr-1.example.dev',
      commit_sha: 'a'.repeat(40),
      observed_at: '2026-09-27T00:00:00Z',
      readiness_type: 'deployment_status_success',
      event_provenance: { kind: 'webhook_signature', verified: true },
    },
    'env',
  );

  it('dedup key is stable across redelivery and distinct across profiles', () => {
    const k = { tenant_id: 't', project_id: 'p', provider: 'github', deployment_id: '99', suite_revision: 'r1', execution_profile: 'chromium_desktop' };
    expect(executionDedupKey(k)).toBe(executionDedupKey({ ...k }));
    expect(executionDedupKey(k)).not.toBe(executionDedupKey({ ...k, execution_profile: 'chromium_mobile_viewport' }));
    expect(executionDedupKey({ ...k, deployment_id: 'a/b' })).not.toBe(executionDedupKey({ ...k, deployment_id: 'a', suite_revision: 'b/r1' }));
  });

  it('rejects a manifest that disagrees with the envelope', () => {
    const ok = { deployment_id: '99', environment: 'preview', immutable_url: 'https://pr-1.example.dev', commit_sha: 'a'.repeat(40), verified_at: '2026-09-27T00:00:00Z', verification: [{ check: 'build_revision', ok: true }] };
    expect(manifestMatchesEnvelope(ok, env)).toEqual([]);
    expect(manifestMatchesEnvelope({ ...ok, commit_sha: 'b'.repeat(40) }, env)).toContain('commit_sha mismatch');
    expect(manifestMatchesEnvelope({ ...ok, verification: [] }, env)).toContain('no verification checks recorded');
  });

  it('requires a full SHA', () => {
    expect(DeploymentEnvelope.safeParse({ ...env, commit_sha: 'abc123' }).success).toBe(false);
  });
});

describe('control bindings', () => {
  it('binds known controls and leaves the rest unknown', async () => {
    const { bindControl } = await import('../src/index.ts');
    expect(bindControl(policy, { role: 'button', name: 'Place order' })).toEqual({ intent: 'checkout.submit', risk_class: 'test_owned_mutation' });
    expect(bindControl(policy, { role: 'button', name: 'Delete Groceries' })).toEqual({ risk_class: 'read_only' });
    expect(bindControl(policy, { role: 'button', name: 'Delete Groceries now please' }).risk_class).toBe('read_only');
    expect(bindControl(policy, { role: 'button', name: 'Place order now' })).toEqual({ risk_class: 'unknown' });
    expect(bindControl(policy, { role: 'link', name: 'Cart' })).toEqual({ risk_class: 'read_only' });
    expect(bindControl(policy, { role: 'button', name: 'Continue' })).toEqual({ risk_class: 'unknown' });
  });
});
