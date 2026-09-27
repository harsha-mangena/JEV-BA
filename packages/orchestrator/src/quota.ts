import type { Db } from '@qa/db';
import { CircuitBreakerProvider, ProviderUnavailableError, type S1RawResponse, type S1Request, type SystemOneProvider } from '@qa/s1';

/** Per-tenant daily System One request quota, enforced atomically in the database. */
export class QuotaProvider implements SystemOneProvider {
  constructor(
    private readonly inner: SystemOneProvider,
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  get id() {
    return this.inner.id;
  }

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const r = await this.db.one<{ requests: number; quota: number }>(
      `with q as (select s1_daily_quota from tenants where id=$1)
       insert into provider_usage(tenant_id, day, provider, requests) values ($1, current_date, $2, 1)
       on conflict (tenant_id, day, provider) do update set requests = provider_usage.requests + 1
       returning requests, (select s1_daily_quota from q) as quota`,
      [this.tenantId, this.inner.id],
    );
    if (!r || r.requests > r.quota) throw new ProviderUnavailableError(`System One daily quota exhausted for tenant ${this.tenantId}`);
    return this.inner.ask(req, signal);
  }
}

/** Default per-tenant wrapping: quota first (cheap refusal), then a shared circuit breaker. */
export function tenantProviderFactory(db: Db, o: { failureThreshold?: number; cooldownMs?: number } = {}) {
  const breakers = new Map<SystemOneProvider, CircuitBreakerProvider>();
  return (tenantId: string, inner: SystemOneProvider): SystemOneProvider => {
    let cb = breakers.get(inner);
    if (!cb) breakers.set(inner, (cb = new CircuitBreakerProvider(inner, o)));
    return new QuotaProvider(cb, db, tenantId);
  };
}
