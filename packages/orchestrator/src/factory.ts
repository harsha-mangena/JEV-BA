import { readFileSync } from 'node:fs';
import type { Db } from '@qa/db';
import { FsArtifactStore, S3ArtifactStore, type ArtifactStore } from '@qa/evidence';
import { ArtifactBaselineStore } from '@qa/quality';
import { tenantProviderFactory } from './quota.ts';
import {
  publishToAll,
  VercelChecksPublisher,
  VercelClient,
  VercelDeploymentVerifier,
  type StatusPublisher,
  GitHubAppTokenProvider,
  GitHubClient,
  GitHubDeploymentVerifier,
  GitHubStatusPublisher,
  PipelineDeploymentVerifier,
  StaticTokenProvider,
  type TokenProvider,
} from '@qa/integrations';
import { GitDiffProvider, GitHubDiffProvider } from '@qa/coverage';
import { impactSelector } from './impact.ts';
import type { OrchestratorDeps } from './service.ts';
import type { ProjectRow } from './types.ts';

/**
 * Production dependencies from environment:
 *  - GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_FILE (per-project installation id), or GITHUB_TOKEN
 *  - GITHUB_API_URL (GitHub Enterprise)
 *  - QA_SUITE_BASE_DIR (where project suite paths resolve)
 */
export function depsFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): OrchestratorDeps {
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  const clients = new Map<string, GitHubClient>();
  const clientFor = (project: ProjectRow): GitHubClient => {
    const key = project.github_installation_id ?? 'static';
    let c = clients.get(key);
    if (!c) {
      let tokens: TokenProvider;
      if (env.GITHUB_APP_ID && project.github_installation_id) {
        const pem = env.GITHUB_APP_PRIVATE_KEY ?? (env.GITHUB_APP_PRIVATE_KEY_FILE ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8') : undefined);
        if (!pem) throw new Error('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required with GITHUB_APP_ID');
        tokens = new GitHubAppTokenProvider({ appId: env.GITHUB_APP_ID, privateKeyPem: pem, installationId: project.github_installation_id, apiUrl });
      } else if (env.GITHUB_TOKEN) {
        tokens = new StaticTokenProvider(env.GITHUB_TOKEN);
      } else {
        throw new Error(`no GitHub credentials for project ${project.id}`);
      }
      c = new GitHubClient(tokens, apiUrl);
      clients.set(key, c);
    }
    return c;
  };
  const baseDir = env.QA_SUITE_BASE_DIR ?? process.cwd();
  const artifacts: ArtifactStore | undefined = env.QA_S3_BUCKET
    ? new S3ArtifactStore({
        endpoint: env.QA_S3_ENDPOINT ?? `https://s3.${env.QA_S3_REGION ?? 'us-east-1'}.amazonaws.com`,
        bucket: env.QA_S3_BUCKET,
        region: env.QA_S3_REGION ?? 'us-east-1',
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        pathStyle: env.QA_S3_PATH_STYLE !== 'false',
        ...(env.QA_S3_PREFIX ? { prefix: env.QA_S3_PREFIX } : {}),
      })
    : env.QA_ARTIFACT_DIR
      ? new FsArtifactStore(env.QA_ARTIFACT_DIR)
      : undefined;
  const vercel = env.VERCEL_TOKEN ? new VercelClient(env.VERCEL_TOKEN, { ...(env.VERCEL_TEAM_ID ? { teamId: env.VERCEL_TEAM_ID } : {}) }) : null;
  return {
    ...(artifacts ? { artifacts, baselinesFor: (p: ProjectRow) => new ArtifactBaselineStore(artifacts, `baselines/${p.tenant_id}/${p.id}`) } : {}),
    s1For: tenantProviderFactory(db),
    select: impactSelector({
      baseDir,
      diffFor: (ctx) => (env.QA_REPO_DIR ? new GitDiffProvider(env.QA_REPO_DIR) : ctx.project.repository_full_name ? new GitHubDiffProvider(clientFor(ctx.project), ctx.project.repository_full_name) : null),
    }),
    db,
    env,
    suiteBaseDir: env.QA_SUITE_BASE_DIR ?? process.cwd(),
    verifierFor: (project, provider) => {
      if (provider === 'github') return new GitHubDeploymentVerifier(clientFor(project));
      if (provider === 'vercel') {
        if (!vercel) throw new Error('VERCEL_TOKEN is required to verify Vercel deployments');
        return new VercelDeploymentVerifier(vercel);
      }
      return new PipelineDeploymentVerifier();
    },
    publisherFor: (project) => {
      const log: StatusPublisher = { publish: async (st) => console.log(`[status] ${project.id} ${st.sha.slice(0, 12)} ${st.context} ${st.state}: ${st.description}`) };
      const gh = project.repository_full_name ? new GitHubStatusPublisher(clientFor(project)) : log;
      return vercel ? publishToAll(gh, new VercelChecksPublisher(vercel)) : gh;
    },
  };
}
