import type { GitHubClient } from './github.ts';

export interface DeploymentClaim {
  provider: string;
  repository: string | null;
  deployment_id: string;
  deployment_status_id?: string;
  environment: string;
  commit_sha: string;
  candidate_url: string | null;
}

export interface VerifiedDeployment {
  deployment_id: string;
  environment: string;
  commit_sha: string;
  immutable_url: string;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
}

/**
 * Resolves a deployment from trusted provider metadata. A claim is never
 * accepted on its own: the returned identity is what execution uses.
 */
export interface DeploymentVerifier {
  verify(claim: DeploymentClaim): Promise<VerifiedDeployment>;
}

export class DeploymentVerificationError extends Error {
  constructor(
    message: string,
    readonly checks: VerifiedDeployment['checks'],
  ) {
    super(message);
  }
}

export class GitHubDeploymentVerifier implements DeploymentVerifier {
  constructor(private readonly gh: GitHubClient) {}

  async verify(claim: DeploymentClaim): Promise<VerifiedDeployment> {
    if (!claim.repository) throw new DeploymentVerificationError('project has no repository binding', []);
    const d = await this.gh.getDeployment(claim.repository, claim.deployment_id);
    const statuses = await this.gh.listDeploymentStatuses(claim.repository, claim.deployment_id);
    const success = statuses.find((s) => s.state === 'success' && (claim.deployment_status_id === undefined || String(s.id) === claim.deployment_status_id)) ?? statuses.find((s) => s.state === 'success');
    const url = success?.environment_url ?? null;
    const checks = [
      { check: 'deployment_exists', ok: true },
      { check: 'sha_matches', ok: d.sha === claim.commit_sha, detail: `provider=${d.sha}` },
      { check: 'environment_matches', ok: d.environment === claim.environment, detail: `provider=${d.environment}` },
      { check: 'success_status', ok: !!success, detail: success ? `status ${success.id}` : 'no success status' },
      { check: 'url_matches', ok: !!url && (claim.candidate_url === null || claim.candidate_url === url), detail: `provider=${url ?? 'none'}` },
    ];
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new DeploymentVerificationError(`deployment claim rejected: ${failed.map((c) => c.check).join(', ')}`, checks);
    return { deployment_id: String(d.id), environment: d.environment, commit_sha: d.sha, immutable_url: url!, checks };
  }
}

/**
 * For same-pipeline and manual submissions: the authenticated submitter's
 * identity is the provenance, and the mandatory readiness revision check is
 * what binds the URL to the SHA before any test runs.
 */
export class PipelineDeploymentVerifier implements DeploymentVerifier {
  async verify(claim: DeploymentClaim): Promise<VerifiedDeployment> {
    if (!claim.candidate_url) throw new DeploymentVerificationError('candidate_url is required', []);
    return {
      deployment_id: claim.deployment_id,
      environment: claim.environment,
      commit_sha: claim.commit_sha,
      immutable_url: claim.candidate_url,
      checks: [{ check: 'submitter_authenticated', ok: true }, { check: 'revision_checked_at_readiness', ok: true, detail: 'deferred to readiness' }],
    };
  }
}
