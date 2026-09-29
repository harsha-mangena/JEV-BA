import { ProvisionedFixture, parseWith } from '@qa/contracts';
import type { AdapterCapabilities, ApplicationAdapter, EffectLookup, EffectReceipt } from './adapter.ts';

export class FixtureServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FixtureServiceError';
  }
}

export interface OwnedOrder {
  id: string;
  total_minor_units: number;
}

/**
 * Fixture-shop application adapter: provisions test-owned entities and reads
 * backend state independently of the UI. Every call is bounded by its own
 * timeout *and* the caller's signal (attempt cancellation/deadline).
 */
/** Identity of this adapter (bound into every execution contract that uses it). */
export const FIXTURE_ADAPTER = { id: 'fixture-shop', adapter_version: 'fixture-shop-adapter/3' } as const;

export class FixtureClient implements ApplicationAdapter {
  readonly id = FIXTURE_ADAPTER.id;
  readonly adapter_version = FIXTURE_ADAPTER.adapter_version;
  readonly capabilities: AdapterCapabilities = {
    readiness: true,
    fixtures: true,
    sessions: true,
    ownership: true,
    oracles: ['order', 'note', 'profile'],
    effect_lookup: true,
    idempotency: true,
    cleanup: true,
    keyed_intents: ['checkout.submit', 'cart.add'],
    idempotency_header: 'x-qa-idempotency-key',
  };

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { 'x-qa-fixture-token': this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? null : JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FixtureServiceError(`${method} ${path}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new FixtureServiceError(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FixtureServiceError(`${method} ${path}: invalid JSON response`);
    }
  }

  async provision(name: string, signal?: AbortSignal): Promise<ProvisionedFixture> {
    return parseWith(ProvisionedFixture, await this.call('POST', '/__qa/fixtures', { name }, signal), `fixture ${name}`);
  }

  async cleanup(fixtureId: string, signal?: AbortSignal): Promise<number> {
    return (await this.call<{ removed: number }>('DELETE', `/__qa/fixtures/${encodeURIComponent(fixtureId)}`, undefined, signal)).removed;
  }

  async orders(userId: string, signal?: AbortSignal): Promise<OwnedOrder[]> {
    return (await this.call<{ orders: OwnedOrder[] }>('GET', `/__qa/users/${encodeURIComponent(userId)}/orders`, undefined, signal)).orders;
  }

  async notes(userId: string, signal?: AbortSignal): Promise<Array<{ id: string }>> {
    return (await this.call<{ notes: Array<{ id: string }> }>('GET', `/__qa/users/${encodeURIComponent(userId)}/notes`, undefined, signal)).notes;
  }

  async user(userId: string, signal?: AbortSignal): Promise<{ id: string; preferences: Record<string, unknown>; profile: { nickname: string; email_offers: boolean } }> {
    return this.call('GET', `/__qa/users/${encodeURIComponent(userId)}`, undefined, signal);
  }

  async entities(kind: string, owner: string, signal?: AbortSignal): Promise<Array<{ id: string } & Record<string, unknown>>> {
    if (kind === 'order') return (await this.orders(owner, signal)) as unknown as Array<{ id: string } & Record<string, unknown>>;
    if (kind === 'note') return this.notes(owner, signal);
    if (kind === 'profile') {
      const u = await this.user(owner, signal);
      return [{ id: u.id, ...u.profile }];
    }
    throw new FixtureServiceError(`fixture-shop has no oracle for entity kind ${kind}`);
  }

  async lookupEffects(idempotencyKey: string, signal?: AbortSignal): Promise<EffectLookup> {
    const r = await this.call<{ effects: EffectReceipt[]; in_flight: number }>('GET', `/__qa/effects?key=${encodeURIComponent(idempotencyKey)}`, undefined, signal);
    return { receipts: r.effects, in_flight: r.in_flight };
  }

  async version(signal?: AbortSignal): Promise<{ commit_sha: string }> {
    return this.call('GET', '/__qa/version', undefined, signal);
  }

  async setDefects(defects: string[]): Promise<void> {
    await this.call('PUT', '/__qa/defects', { defects });
  }
}
