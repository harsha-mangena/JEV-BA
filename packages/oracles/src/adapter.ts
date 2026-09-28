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
  /** Effects recorded under an idempotency key; empty when none. */
  lookupEffects(idempotencyKey: string, signal?: AbortSignal): Promise<EffectReceipt[]>;
  version(signal?: AbortSignal): Promise<{ commit_sha: string }>;
}
