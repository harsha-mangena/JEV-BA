import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeploymentVerificationError, type DeploymentClaim, type DeploymentVerifier, type VerifiedDeployment } from './deployments.ts';
import type { CommitStatus, StatusPublisher } from './status.ts';

/**
 * Vercel integration. Endpoints and fields follow Vercel's public REST and
 * webhook documentation (deployments v13, deployment checks v1, HMAC-SHA1
 * `x-vercel-signature`); confirm against a live test delivery before relying
 * on it for release gating.
 */
export function verifyVercelSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(createHmac('sha1', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface VercelDeployment {
  id: string;
  url: string;
  readyState?: string;
  target?: string | null;
  createdAt?: number;
  meta?: Record<string, string>;
}

export class VercelClient {
  constructor(
    private readonly token: string,
    private readonly o: { teamId?: string; apiUrl?: string } = {},
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(`${this.o.apiUrl ?? 'https://api.vercel.com'}${path}`);
    if (this.o.teamId) url.searchParams.set('teamId', this.o.teamId);
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? null : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Vercel ${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  getDeployment(id: string) {
    return this.call<VercelDeployment>('GET', `/v13/deployments/${encodeURIComponent(id)}`);
  }
  listChecks(deploymentId: string) {
    return this.call<{ checks: Array<{ id: string; name: string; status: string }> }>('GET', `/v1/deployments/${encodeURIComponent(deploymentId)}/checks`);
  }
  createCheck(deploymentId: string, name: string) {
    return this.call<{ id: string }>('POST', `/v1/deployments/${encodeURIComponent(deploymentId)}/checks`, { name, blocking: true, rerequestable: true });
  }
  updateCheck(deploymentId: string, checkId: string, body: { status: 'running' | 'completed'; conclusion?: 'succeeded' | 'failed' | 'canceled' | 'skipped'; detailsUrl?: string }) {
    return this.call('PATCH', `/v1/deployments/${encodeURIComponent(deploymentId)}/checks/${encodeURIComponent(checkId)}`, body);
  }
}

/** Environment naming: Vercel `target: production` → `production`, otherwise `preview`. */
export const vercelEnvironment = (target: string | null | undefined) => (target === 'production' ? 'production' : 'preview');

export class VercelDeploymentVerifier implements DeploymentVerifier {
  constructor(private readonly client: VercelClient) {}

  async verify(claim: DeploymentClaim): Promise<VerifiedDeployment> {
    const d = await this.client.getDeployment(claim.deployment_id);
    const url = `https://${d.url}`;
    const sha = d.meta?.githubCommitSha ?? d.meta?.gitlabCommitSha ?? d.meta?.bitbucketCommitSha ?? '';
    const checks = [
      { check: 'deployment_exists', ok: true },
      { check: 'ready', ok: d.readyState === 'READY', detail: `readyState=${d.readyState ?? 'unknown'}` },
      { check: 'sha_matches', ok: sha === claim.commit_sha, detail: `provider=${sha || 'none'}` },
      { check: 'environment_matches', ok: vercelEnvironment(d.target) === claim.environment, detail: `provider=${vercelEnvironment(d.target)}` },
      { check: 'url_matches', ok: claim.candidate_url === null || claim.candidate_url === url, detail: `provider=${url}` },
    ];
    const channel = d.meta?.githubPrId ? `pr:${d.meta.githubPrId}` : d.meta?.githubCommitRef ? `ref:${d.meta.githubCommitRef}` : null;
    if (claim.channel !== undefined) checks.push({ check: 'channel_matches', ok: claim.channel === channel, detail: `provider=${channel ?? 'none'}` });
    if (checks.some((c) => !c.ok)) throw new DeploymentVerificationError(`deployment claim rejected: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`, checks);
    return { deployment_id: d.id, environment: vercelEnvironment(d.target), commit_sha: sha, immutable_url: url, checks, channel, sequence: typeof d.createdAt === 'number' ? d.createdAt : null };
  }
}

/**
 * Reports the QA result as a blocking Vercel Deployment Check (which holds
 * production domain assignment — not deployment creation). Idempotent: the
 * check is found by name before being created.
 */
export class VercelChecksPublisher implements StatusPublisher {
  constructor(private readonly client: VercelClient) {}

  async publish(s: CommitStatus): Promise<void> {
    if (s.provider !== 'vercel' || !s.deployment_provider_id) return;
    const existing = (await this.client.listChecks(s.deployment_provider_id)).checks.find((c) => c.name === s.context);
    const id = existing?.id ?? (await this.client.createCheck(s.deployment_provider_id, s.context)).id;
    const conclusion = s.state === 'success' ? 'succeeded' : s.state === 'failure' ? 'failed' : s.state === 'error' ? 'failed' : undefined;
    await this.client.updateCheck(s.deployment_provider_id, id, { status: conclusion ? 'completed' : 'running', ...(conclusion ? { conclusion } : {}), ...(s.target_url ? { detailsUrl: s.target_url } : {}) });
  }
}

/** Fan out one status to several publishers (e.g. GitHub commit status + Vercel check). */
export function publishToAll(...publishers: StatusPublisher[]): StatusPublisher {
  return { publish: async (s) => void (await Promise.all(publishers.map((p) => p.publish(s)))) };
}
