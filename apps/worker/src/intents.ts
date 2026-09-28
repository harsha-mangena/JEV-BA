import type { ApplicationAdapter, EffectReceipt } from '@qa/oracles';

/**
 * Durable action-intent lifecycle (audit F09).
 *
 *   PREPARED ──► DISPATCHING ──► ACKNOWLEDGED ──► EFFECT_CONFIRMED
 *      │              │                │
 *      ▼              ├──► NOT_DISPATCHED
 *   NOT_DISPATCHED    └──► EFFECT_UNKNOWN ──► RECONCILING ──► RECONCILED | NEEDS_REVIEW
 *
 * PREPARED is written before the browser receives any input; DISPATCHING is
 * written immediately before input is sent. A worker that dies leaves the
 * record in one of those states, and recovery can tell "never sent" (PREPARED)
 * from "possibly sent" (DISPATCHING) without guessing.
 */
export type IntentState =
  | 'PREPARED'
  | 'DISPATCHING'
  | 'NOT_DISPATCHED'
  | 'ACKNOWLEDGED'
  | 'EFFECT_CONFIRMED'
  | 'EFFECT_UNKNOWN'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'NEEDS_REVIEW';

export const INTENT_TRANSITIONS: Record<IntentState, IntentState[]> = {
  PREPARED: ['DISPATCHING', 'NOT_DISPATCHED'],
  DISPATCHING: ['ACKNOWLEDGED', 'NOT_DISPATCHED', 'EFFECT_UNKNOWN', 'RECONCILING'],
  ACKNOWLEDGED: ['EFFECT_CONFIRMED', 'EFFECT_UNKNOWN', 'NEEDS_REVIEW'],
  EFFECT_UNKNOWN: ['RECONCILING'],
  RECONCILING: ['RECONCILED', 'NEEDS_REVIEW'],
  NOT_DISPATCHED: [],
  EFFECT_CONFIRMED: [],
  RECONCILED: [],
  NEEDS_REVIEW: [],
};

/** States a recovering worker must resolve before it may run the same work again. */
export const UNRESOLVED: readonly IntentState[] = ['PREPARED', 'DISPATCHING', 'EFFECT_UNKNOWN', 'RECONCILING'];

export interface IntentRecord {
  intent_id: string;
  attempt_id: string;
  scenario_id: string;
  execution_profile: string;
  /** Fixture owner of any entity this intent may create; receipts owned by anyone else are rejected. */
  owner: string | null;
  idempotency_key: string | null;
  effect: string;
  mutation: string | null;
  contract_intent: string | null;
  state: IntentState;
  detail: string | null;
  receipts: EffectReceipt[];
  data: Record<string, unknown>;
}

export class IllegalTransition extends Error {}
/** The caller no longer holds the lease/fence for this work; nothing was written. */
export class FenceLost extends Error {}

export interface IntentStore {
  /** Durably record a new intent in PREPARED. Must complete before any input is dispatched. */
  prepare(r: Omit<IntentRecord, 'state' | 'detail' | 'receipts'>): Promise<void>;
  /** Move an intent to `to`; rejects illegal transitions and lost fences. */
  transition(intentId: string, to: IntentState, detail?: string | null, receipts?: EffectReceipt[]): Promise<void>;
  /** Intents left unresolved by earlier executions of the same unit of work. */
  unresolved(): Promise<IntentRecord[]>;
  get(intentId: string): Promise<IntentRecord | undefined>;
}

/** In-process store (CLI and tests); the service uses the PostgreSQL store with fencing. */
export class MemoryIntentStore implements IntentStore {
  readonly records = new Map<string, IntentRecord>();
  readonly transitions: Array<{ intent_id: string; from: IntentState; to: IntentState; detail: string | null; at: string }> = [];

  async prepare(r: Omit<IntentRecord, 'state' | 'detail' | 'receipts'>): Promise<void> {
    if (this.records.has(r.intent_id)) throw new IllegalTransition(`intent ${r.intent_id} already exists`);
    this.records.set(r.intent_id, { ...r, state: 'PREPARED', detail: null, receipts: [] });
    this.transitions.push({ intent_id: r.intent_id, from: 'PREPARED', to: 'PREPARED', detail: null, at: new Date().toISOString() });
  }

  async transition(intentId: string, to: IntentState, detail: string | null = null, receipts: EffectReceipt[] = []): Promise<void> {
    const r = this.records.get(intentId);
    if (!r) throw new IllegalTransition(`unknown intent ${intentId}`);
    if (!INTENT_TRANSITIONS[r.state].includes(to)) throw new IllegalTransition(`${intentId}: ${r.state} → ${to} is not a legal transition`);
    this.transitions.push({ intent_id: intentId, from: r.state, to, detail, at: new Date().toISOString() });
    r.state = to;
    r.detail = detail;
    if (receipts.length) r.receipts = receipts;
  }

  async unresolved(): Promise<IntentRecord[]> {
    return [...this.records.values()].filter((r) => UNRESOLVED.includes(r.state));
  }

  async get(intentId: string): Promise<IntentRecord | undefined> {
    return this.records.get(intentId);
  }
}

export type Reconciliation =
  | { state: 'RECONCILED'; happened: boolean; receipts: EffectReceipt[]; detail: string }
  | { state: 'NEEDS_REVIEW'; receipts: EffectReceipt[]; detail: string };

export interface ReconcileOptions {
  signal?: AbortSignal;
  /** How long to wait for requests with this key that the application is still processing. */
  settleMs?: number;
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * Determine from the application — never from the browser — whether a
 * possibly-dispatched action took effect. Absence is only proof when the
 * adapter records this intent under its idempotency key and nothing with that
 * key is still being processed; everything else goes to review. Receipts owned
 * by anyone but the fixture owner are treated as forged/foreign and never
 * accepted as this run's effect.
 */
export async function reconcileIntent(r: IntentRecord, adapter: ApplicationAdapter, o: ReconcileOptions = {}): Promise<Reconciliation> {
  if (r.effect === 'none') return { state: 'RECONCILED', happened: false, receipts: [], detail: 'action has no persistent effect' };
  if (r.effect !== 'mutation') return { state: 'NEEDS_REVIEW', receipts: [], detail: `effect ${r.effect} cannot be reconciled automatically` };
  const keyed = r.contract_intent !== null && adapter.capabilities.keyed_intents.includes(r.contract_intent);
  if (!r.idempotency_key || !adapter.capabilities.effect_lookup || !keyed) {
    return { state: 'NEEDS_REVIEW', receipts: [], detail: `${r.contract_intent ?? 'mutation'} is not recorded under an idempotency key by ${adapter.id}; inspect the application` };
  }
  const deadline = Date.now() + (o.settleMs ?? 10_000);
  for (;;) {
    const found = await adapter.lookupEffects(r.idempotency_key, o.signal);
    const foreign = found.receipts.filter((x) => r.owner === null || x.owner !== r.owner);
    if (foreign.length) return { state: 'NEEDS_REVIEW', receipts: found.receipts, detail: `receipt(s) ${foreign.map((x) => x.entity_id).join(', ')} are not owned by fixture owner ${r.owner ?? '(none)'}` };
    if (found.in_flight === 0) {
      return found.receipts.length
        ? { state: 'RECONCILED', happened: true, receipts: found.receipts, detail: `effect confirmed: ${found.receipts.map((x) => `${x.kind} ${x.entity_id}`).join(', ')}` }
        : { state: 'RECONCILED', happened: false, receipts: [], detail: 'no effect recorded under the idempotency key and nothing in flight' };
    }
    if (Date.now() >= deadline) return { state: 'NEEDS_REVIEW', receipts: found.receipts, detail: `${found.in_flight} request(s) with this key still in flight after ${o.settleMs ?? 10_000} ms` };
    await sleep(o.pollMs ?? 100, o.signal);
  }
}

/**
 * Resolve every intent an earlier execution left unresolved, before the same
 * work runs again. PREPARED was never dispatched; anything that may have been
 * dispatched is reconciled against the application.
 */
export async function recoverIntents(store: IntentStore, adapter: ApplicationAdapter, o: ReconcileOptions = {}): Promise<IntentRecord[]> {
  const out: IntentRecord[] = [];
  for (const r of await store.unresolved()) {
    if (r.state === 'PREPARED') {
      await store.transition(r.intent_id, 'NOT_DISPATCHED', 'recovered: input was never dispatched');
    } else {
      if (r.state !== 'RECONCILING') await store.transition(r.intent_id, 'RECONCILING', 'recovered after worker loss');
      const rec = await reconcileIntent(r, adapter, o).catch((e: Error) => ({ state: 'NEEDS_REVIEW' as const, receipts: [], detail: `effect lookup failed: ${e.message}` }));
      await store.transition(r.intent_id, rec.state, rec.detail, rec.receipts);
    }
    out.push((await store.get(r.intent_id))!);
  }
  return out;
}
