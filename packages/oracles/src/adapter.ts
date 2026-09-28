import type { ProvisionedFixture } from '@qa/contracts';

/** Record of an application effect found by an independent lookup (never inferred from navigation). */
export interface EffectReceipt {
  kind: string;
  entity_id: string;
  owner: string;
  idempotency_key: string | null;
  created_at: string | null;
}

export interface AdapterCapabilities {
  readiness: boolean;
  fixtures: boolean;
  sessions: boolean;
  ownership: boolean;
  oracles: string[];
  effect_lookup: boolean;
  idempotency: boolean;
  cleanup: boolean;
  /**
   * Contract intents whose effects the application records under the runner's
   * idempotency key. For these, a lookup with nothing in flight is
   * authoritative: no receipt proves no effect. Other mutations cannot be
   * reconciled automatically and go to review.
   */
  keyed_intents: string[];
  /** Request header that carries the idempotency key (scoped to one dispatch). */
  idempotency_header: string | null;
}

export interface EffectLookup {
  receipts: EffectReceipt[];
  /** Requests carrying this key that the application is still processing. */
  in_flight: number;
}

/**
 * Application adapter: everything application-specific the generic runtime
 * needs — readiness/version, fixtures and sessions, ownership, independent
 * oracles, effect lookup/reconciliation and cleanup. Business-specific
 * oracles live here; generic UI assertions stay in the runtime.
 */
export interface ApplicationAdapter {
  readonly id: string;
  readonly adapter_version: string;
  readonly capabilities: AdapterCapabilities;
  provision(name: string, signal?: AbortSignal): Promise<ProvisionedFixture>;
  cleanup(fixtureId: string, signal?: AbortSignal): Promise<number>;
  /** Entities of `kind` owned by `owner` (independent backend read). */
  entities(kind: string, owner: string, signal?: AbortSignal): Promise<Array<{ id: string } & Record<string, unknown>>>;
  /** Effects recorded under an idempotency key, plus requests with that key still being processed. */
  lookupEffects(idempotencyKey: string, signal?: AbortSignal): Promise<EffectLookup>;
  version(signal?: AbortSignal): Promise<{ commit_sha: string }>;
}
