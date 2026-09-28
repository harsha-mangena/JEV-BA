import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createIsolatedDb, dropSchema, type Db } from '@qa/db';
import {
  GitHubClient,
  GitHubDeploymentVerifier,
  GitHubStatusPublisher,
  PipelineDeploymentVerifier,
  RecordingStatusPublisher,
  StaticTokenProvider,
} from '@qa/integrations';
import { bootstrapProject, JobWorker, Orchestrator, type OrchestratorDeps } from '@qa/orchestrator';
import { buildApi, type ApiOptions } from '@qa/api';

export const ROOT = join(import.meta.dirname, '../..');
export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && process.env.QA_REQUIRE_SERVICE === '1') {
  // A mandatory service lane must fail visibly, never skip, when its database is missing.
  throw new Error('QA_REQUIRE_SERVICE=1 but DATABASE_URL is not set: the service lane cannot run');
}
export const FIXTURE_TOKEN = 'svc-fixture-token-0123456789';
export const WEBHOOK_SECRET = 'webhook-secret-for-tests';

export function projectConfig(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    environments: {
      preview: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true },
      staging: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true },
    },
    version_check: { kind: 'json', path: '/healthz', field: 'commit_sha' },
    readiness: { timeout_seconds: 2, interval_seconds: 0.2 },
    suite: {
      specs_dir: 'specs',
      policy_file: 'specs/policies/fixture-shop.yaml',
      fixture_catalog: 'specs/fixtures.yaml',
      profiles: ['chromium_desktop'],
      shards: 2,
      concurrency: 2,
      signed_out_path: '/login',
    },
    fixture_api: { token_env: 'QA_FIXTURE_TOKEN_SHOP' },
    status: { dashboard_url: 'https://qa.example.test' },
    ...overrides,
  };
}

/** Minimal GitHub API double: deployments, deployment statuses, commit statuses, compare. */
export class FakeGitHub {
  deployments = new Map<string, { sha: string; environment: string; ref?: string; statuses: Array<{ id: number; state: string; environment_url: string }> }>();
  commitStatuses: Array<{ repo: string; sha: string; state: string; context: string; description: string; target_url?: string }> = [];
  compares = new Map<string, { status: string; files: Array<{ filename: string; status: string; previous_filename?: string }> }>();
  server!: Server;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const send = (code: number, body: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== 'Bearer gh-test-token') return send(401, { message: 'Bad credentials' });
        const url = new URL(req.url!, 'http://x');
        let m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/deployments\/(\d+)(\/statuses)?$/);
        if (m && req.method === 'GET') {
          const d = this.deployments.get(m[2]!);
          if (!d) return send(404, { message: 'Not Found' });
          return m[3] ? send(200, d.statuses) : send(200, { id: Number(m[2]), sha: d.sha, environment: d.environment, ...(d.ref ? { ref: d.ref } : {}) });
        }
        m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/statuses\/([0-9a-f]{40})$/);
        if (m && req.method === 'POST') {
          this.commitStatuses.push({ repo: m[1]!, sha: m[2]!, ...JSON.parse(Buffer.concat(chunks).toString()) });
          return send(201, {});
        }
        m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
        if (m && req.method === 'GET') {
          const c = this.compares.get(`${m[2]}...${m[3]}`);
          return c ? send(200, c) : send(404, { message: 'Not Found' });
        }
        send(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  deploy(id: number, sha: string, environment: string, url: string, ref?: string): void {
    this.deployments.set(String(id), { sha, environment, ...(ref ? { ref } : {}), statuses: [{ id: id * 10, state: 'success', environment_url: url }] });
  }

  latest(sha: string) {
    return [...this.commitStatuses].reverse().find((s) => s.sha === sha);
  }

  close(): Promise<void> {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

export function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface Harness {
  db: Db;
  schema: string;
  gh: FakeGitHub;
  orch: Orchestrator;
  api: Awaited<ReturnType<typeof buildApi>>;
  worker: JobWorker;
  tokens: Record<string, string>;
  publisher: RecordingStatusPublisher;
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Record<string, unknown>;
  outDir: string;
  maxConcurrentJobs?: number;
  deps?: Partial<OrchestratorDeps>;
  api?: ApiOptions;
}

export async function harness(opts: HarnessOptions): Promise<Harness> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const db = await createIsolatedDb(DATABASE_URL!, schema);
  const gh = await new FakeGitHub().start();
  const env = { ...process.env, QA_FIXTURE_TOKEN_SHOP: FIXTURE_TOKEN, SHOP_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const client = new GitHubClient(new StaticTokenProvider('gh-test-token'), gh.url);
  const publisher = new RecordingStatusPublisher();
  const ghPublisher = new GitHubStatusPublisher(client);
  const orch = new Orchestrator({
    db,
    suiteBaseDir: ROOT,
    env,
    verifierFor: (_p, provider) => (provider === 'github' ? new GitHubDeploymentVerifier(client) : new PipelineDeploymentVerifier()),
    publisherFor: () => ({
      publish: async (s) => {
        await publisher.publish(s);
        await ghPublisher.publish(s);
      },
    }),
    ...opts.deps,
  });
  const tokens = await bootstrapProject(db, {
    tenant: { id: 'acme', max_concurrent_jobs: opts.maxConcurrentJobs ?? 4 },
    project: { id: 'shop', repository_id: '4242', repository_full_name: 'acme/shop', config: opts.config ?? projectConfig(), webhook_secret_ref: 'SHOP_WEBHOOK_SECRET' },
    tokens: [
      { role: 'submitter', label: 'ci' },
      { role: 'viewer', label: 'viewer' },
      { role: 'admin', label: 'admin' },
      { role: 'reviewer', label: 'reviewer' },
    ],
  });
  const api = await buildApi(orch, { env, ...opts.api });
  const worker = new JobWorker(orch, { outDir: opts.outDir, env, leaseSeconds: 30, cancelPollMs: 200 });
  return {
    db,
    schema,
    gh,
    orch,
    api,
    worker,
    tokens,
    publisher,
    env,
    async close() {
      await api.close();
      await gh.close();
      await db.close();
      await dropSchema(DATABASE_URL!, schema);
    },
  };
}
