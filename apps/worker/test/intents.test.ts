import { describe, expect, it } from 'vitest';
import type { ApplicationAdapter, EffectLookup } from '@qa/oracles';
import { IllegalTransition, MemoryIntentStore, reconcileIntent, recoverIntents, type IntentRecord } from '../src/intents.ts';

function adapter(lookups: EffectLookup[], keyed = ['checkout.submit']): ApplicationAdapter & { calls: number } {
  const a = {
    id: 'fake',
    adapter_version: 'fake/1',
    calls: 0,
    capabilities: { readiness: true, fixtures: true, sessions: true, ownership: true, oracles: [], effect_lookup: true, idempotency: true, cleanup: true, keyed_intents: keyed, idempotency_header: 'x-key' },
    provision: async () => Promise.reject(new Error('unused')),
    cleanup: async () => 0,
    entities: async () => [],
    version: async () => ({ commit_sha: 'x' }),
    async lookupEffects() {
      return lookups[Math.min(a.calls++, lookups.length - 1)]!;
    },
  };
  return a;
}

const base: Omit<IntentRecord, 'state' | 'detail' | 'receipts'> = {
  intent_id: 'a1.i2',
  attempt_id: 'a1',
  scenario_id: 'checkout',
  execution_profile: 'chromium_desktop',
  owner: 'u_1',
  idempotency_key: 'a1.i2',
  effect: 'mutation',
  mutation: 'test_owned_order_create',
  contract_intent: 'checkout.submit',
  data: {},
};
const receipt = (owner = 'u_1') => ({ kind: 'order', entity_id: 'ord_1', owner, idempotency_key: 'a1.i2', created_at: null });

describe('intent state machine', () => {
  it('permits only the documented transitions', async () => {
    const s = new MemoryIntentStore();
    await s.prepare(base);
    await expect(s.transition(base.intent_id, 'ACKNOWLEDGED')).rejects.toThrow(IllegalTransition);
    await s.transition(base.intent_id, 'DISPATCHING');
    await s.transition(base.intent_id, 'ACKNOWLEDGED');
    await s.transition(base.intent_id, 'EFFECT_CONFIRMED');
    await expect(s.transition(base.intent_id, 'RECONCILING')).rejects.toThrow(IllegalTransition);
    await expect(s.prepare(base)).rejects.toThrow(/already exists/);
  });
});

describe('reconciliation', () => {
  const rec = (over: Partial<IntentRecord> = {}): IntentRecord => ({ ...base, state: 'RECONCILING', detail: null, receipts: [], ...over });

  it('confirms an effect from an owned receipt, after in-flight requests settle', async () => {
    const a = adapter([{ receipts: [], in_flight: 1 }, { receipts: [receipt()], in_flight: 0 }]);
    expect(await reconcileIntent(rec(), a, { pollMs: 1 })).toMatchObject({ state: 'RECONCILED', happened: true, receipts: [receipt()] });
    expect(a.calls).toBe(2);
  });

  it('treats absence as proof only when nothing with the key is in flight', async () => {
    expect(await reconcileIntent(rec(), adapter([{ receipts: [], in_flight: 0 }]))).toMatchObject({ state: 'RECONCILED', happened: false });
    expect(await reconcileIntent(rec(), adapter([{ receipts: [], in_flight: 1 }]), { settleMs: 5, pollMs: 1 })).toMatchObject({ state: 'NEEDS_REVIEW' });
  });

  it('rejects receipts owned by someone other than the fixture owner', async () => {
    const r = await reconcileIntent(rec(), adapter([{ receipts: [receipt('u_other')], in_flight: 0 }]));
    expect(r).toMatchObject({ state: 'NEEDS_REVIEW' });
    expect(r.detail).toMatch(/not owned by fixture owner u_1/);
  });

  it('sends unkeyed mutations and external effects to review instead of guessing', async () => {
    expect(await reconcileIntent(rec({ contract_intent: 'profile.autosave' }), adapter([{ receipts: [], in_flight: 0 }]))).toMatchObject({ state: 'NEEDS_REVIEW' });
    expect(await reconcileIntent(rec({ idempotency_key: null }), adapter([{ receipts: [], in_flight: 0 }]))).toMatchObject({ state: 'NEEDS_REVIEW' });
    expect(await reconcileIntent(rec({ effect: 'external' }), adapter([]))).toMatchObject({ state: 'NEEDS_REVIEW' });
    expect(await reconcileIntent(rec({ effect: 'none' }), adapter([]))).toMatchObject({ state: 'RECONCILED', happened: false });
  });
});

describe('recovery after worker loss', () => {
  it('resolves PREPARED as never dispatched and reconciles DISPATCHING against the application', async () => {
    const s = new MemoryIntentStore();
    await s.prepare({ ...base, intent_id: 'p', idempotency_key: 'p' });
    await s.prepare(base);
    await s.transition(base.intent_id, 'DISPATCHING');
    await s.prepare({ ...base, intent_id: 'done', idempotency_key: 'done' });
    await s.transition('done', 'DISPATCHING');
    await s.transition('done', 'ACKNOWLEDGED');
    const out = await recoverIntents(s, adapter([{ receipts: [receipt()], in_flight: 0 }]));
    expect(Object.fromEntries(out.map((r) => [r.intent_id, r.state]))).toEqual({ p: 'NOT_DISPATCHED', [base.intent_id]: 'RECONCILED' });
    expect((await s.get(base.intent_id))!.receipts).toEqual([receipt()]);
    expect(await s.unresolved()).toEqual([]);
  });

  it('marks an intent for review when the lookup itself fails', async () => {
    const s = new MemoryIntentStore();
    await s.prepare(base);
    await s.transition(base.intent_id, 'DISPATCHING');
    const broken = { ...adapter([]), lookupEffects: async () => Promise.reject(new Error('503')) };
    const [r] = await recoverIntents(s, broken);
    expect(r).toMatchObject({ state: 'NEEDS_REVIEW', detail: 'effect lookup failed: 503' });
  });
});
