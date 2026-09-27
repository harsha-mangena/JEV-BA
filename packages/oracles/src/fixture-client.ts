import { ProvisionedFixture, parseWith } from '@qa/contracts';

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
 * Client for the test tenant's fixture/read-only backend API. Used both to
 * provision test-owned entities and as an oracle independent of the UI.
 */
export class FixtureClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { 'x-qa-fixture-token': this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? null : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
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

  async provision(name: string): Promise<ProvisionedFixture> {
    return parseWith(ProvisionedFixture, await this.call('POST', '/__qa/fixtures', { name }), `fixture ${name}`);
  }

  async cleanup(fixtureId: string): Promise<number> {
    return (await this.call<{ removed: number }>('DELETE', `/__qa/fixtures/${encodeURIComponent(fixtureId)}`)).removed;
  }

  async orders(userId: string): Promise<OwnedOrder[]> {
    return (await this.call<{ orders: OwnedOrder[] }>('GET', `/__qa/users/${encodeURIComponent(userId)}/orders`)).orders;
  }

  async notes(userId: string): Promise<Array<{ id: string }>> {
    return (await this.call<{ notes: Array<{ id: string }> }>('GET', `/__qa/users/${encodeURIComponent(userId)}/notes`)).notes;
  }

  async version(): Promise<{ commit_sha: string }> {
    return this.call('GET', '/__qa/version');
  }

  async setDefects(defects: string[]): Promise<void> {
    await this.call('PUT', '/__qa/defects', { defects });
  }
}
