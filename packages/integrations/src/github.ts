import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/** Verify `X-Hub-Signature-256` over the exact raw request body (constant-time). */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=') || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface TokenProvider {
  token(): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** RS256 JWT for GitHub App authentication (valid ≤ 10 minutes, backdated for clock skew). */
export function githubAppJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** Installation access tokens, cached until shortly before expiry. */
export class GitHubAppTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(
    private readonly o: { appId: string; privateKeyPem: string; installationId: number | string; apiUrl?: string },
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    const res = await fetch(`${this.o.apiUrl ?? 'https://api.github.com'}/app/installations/${this.o.installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${githubAppJwt(this.o.appId, this.o.privateKeyPem)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub App token exchange failed: HTTP ${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GitHubDeployment {
  id: number;
  sha: string;
  environment: string;
  ref?: string;
}
export interface GitHubDeploymentStatus {
  id: number;
  state: string;
  environment_url?: string | null;
  target_url?: string | null;
}

export class GitHubClient {
  constructor(
    private readonly tokens: TokenProvider,
    readonly apiUrl = 'https://api.github.com',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.tokens.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new GitHubApiError(`${method} ${path}: HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  getDeployment(repo: string, id: string | number): Promise<GitHubDeployment> {
    return this.call('GET', `/repos/${repo}/deployments/${encodeURIComponent(String(id))}`);
  }

  listDeploymentStatuses(repo: string, id: string | number): Promise<GitHubDeploymentStatus[]> {
    return this.call('GET', `/repos/${repo}/deployments/${encodeURIComponent(String(id))}/statuses?per_page=100`);
  }

  createCommitStatus(repo: string, sha: string, s: { state: 'pending' | 'success' | 'failure' | 'error'; context: string; description: string; target_url?: string }): Promise<unknown> {
    return this.call('POST', `/repos/${repo}/statuses/${sha}`, { ...s, description: s.description.slice(0, 140) });
  }

  compare(repo: string, base: string, head: string): Promise<{ status: 'ahead' | 'behind' | 'identical' | 'diverged'; files?: Array<{ filename: string; status: string; previous_filename?: string }> }> {
    return this.call('GET', `/repos/${repo}/compare/${base}...${head}`);
  }
}
