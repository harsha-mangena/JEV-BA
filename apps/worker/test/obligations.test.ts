import { describe, expect, it } from 'vitest';
import type { ApplicationAdapter, EffectLookup } from '@qa/oracles';
import { MemoryIntentStore, recoverIntents, type NewIntent } from '../src/intents.ts';

/**
 * Re-audit R1: an uncertain effect is an obligation until it is verified or
 * explicitly adjudicated. A crash after acknowledgement, or a recovery that
 * ends in review, must never leave the obligation invisible to the next pass.
 */

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

const keyed: NewIntent = {
  intent_id: 'a1.checkout',
  attempt_id: 'a1',
  scenario_id: 'checkout',
  execution_profile: 'chromium_desktop',
  owner: 'u_1',
  idempotency_key: 'a1.checkout',
  effect: 'mutation',
  mutation: 'test_owned_order_create',
  contract_intent: 'checkout.submit',
  data: {},
};
const unkeyed = { ...keyed, intent_id: 'a1.delete', idempotency_key: null, mutation: 'test_owned_note_write', contract_intent: 'notes.delete', scenario_id: 'notes_crud' };
const read = { ...keyed, intent_id: 'a1.open', idempotency_key: null, effect: 'none', mutation: null, contract_intent: null };
const order = { kind: 'order', entity_id: 'ord_1', owner: 'u_1', idempotency_key: 'a1.checkout', created_at: null };

async function acknowledged(s: MemoryIntentStore, r: typeof keyed) {
  await s.prepare(r);
  await s.transition(r.intent_id, 'DISPATCHING');
  await s.transition(r.intent_id, 'ACKNOWLEDGED');
}

describe('R1a: a crash between acknowledgement and effect confirmation', () => {
  it('reconciles an acknowledged keyed mutation against the application instead of leaving it acknowledged', async () => {
    const s = new MemoryIntentStore();
    await acknowledged(s, keyed);
    const a = adapter([{ receipts: [order], in_flight: 0 }]);
    const out = await recoverIntents(s, a);
    expect(a.calls).toBeGreaterThan(0);
    expect(out.map((r) => [r.intent_id, r.state])).toEqual([[keyed.intent_id, 'RECONCILED']]);
    expect((await s.get(keyed.intent_id))!.receipts).toEqual([order]);
    expect(await s.outstanding()).toEqual([]);
  });

  it('sends an acknowledged mutation that cannot be looked up to review, and leaves acknowledged reads and settled attempts alone', async () => {
    const s = new MemoryIntentStore();
    await acknowledged(s, unkeyed);
    await acknowledged(s, read);
    await acknowledged(s, { ...unkeyed, intent_id: 'a0.delete', attempt_id: 'a0' });
    await s.transition('a0.delete', 'SETTLED', 'owning attempt finished under its live lease');
    const out = await recoverIntents(s, adapter([]));
    expect(out.map((r) => [r.intent_id, r.state])).toEqual([[unkeyed.intent_id, 'NEEDS_REVIEW']]);
    expect((await s.get(read.intent_id))!.state).toBe('ACKNOWLEDGED');
    expect((await s.get('a0.delete'))!.state).toBe('SETTLED');
  });
});

describe('R1b: review obligations survive later recovery passes', () => {
  it('surfaces a NEEDS_REVIEW intent on every later pass until an authorized adjudication resolves it', async () => {
    const s = new MemoryIntentStore();
    await s.prepare(unkeyed);
    await s.transition(unkeyed.intent_id, 'DISPATCHING');
    const first = await recoverIntents(s, adapter([]));
    expect(first.map((r) => r.state)).toEqual(['NEEDS_REVIEW']);
    const transitions = s.transitions.length;

    const second = await recoverIntents(s, adapter([]));
    expect(second.map((r) => [r.intent_id, r.state])).toEqual([[unkeyed.intent_id, 'NEEDS_REVIEW']]);
    expect(s.transitions.length).toBe(transitions);
    expect((await s.outstanding()).map((r) => r.intent_id)).toEqual([unkeyed.intent_id]);

    await expect(s.adjudicate(unkeyed.intent_id, { resolution: 'effect_absent', by: '', note: 'checked' })).rejects.toThrow(/actor/);
    await s.adjudicate(unkeyed.intent_id, { resolution: 'effect_absent', by: 'admin:ops', note: 'note still present in the application' });
    expect(await s.outstanding()).toEqual([]);
    expect((await s.get(unkeyed.intent_id))!.adjudication).toMatchObject({ resolution: 'effect_absent', by: 'admin:ops' });
    expect(await recoverIntents(s, adapter([]))).toEqual([]);
  });

  it('refuses to adjudicate an intent that is not waiting for review', async () => {
    const s = new MemoryIntentStore();
    await acknowledged(s, read);
    await expect(s.adjudicate(read.intent_id, { resolution: 'effect_absent', by: 'admin:ops', note: 'x' })).rejects.toThrow(/not awaiting review/);
  });
});
