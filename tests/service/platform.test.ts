import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsArtifactStore } from '@qa/evidence';
import { startFixtureApp, type DefectId, type FixtureApp } from '@qa/fixture-test-app';
import { VercelClient, VercelDeploymentVerifier, PipelineDeploymentVerifier, GitHubDeploymentVerifier, GitHubClient, StaticTokenProvider } from '@qa/integrations';
import { bootstrapProject, QuotaProvider, Sweeper, type ProjectRow } from '@qa/orchestrator';
import { ArtifactBaselineStore } from '@qa/quality';
import { FixtureClient } from '@qa/oracles';
import { ProviderUnavailableError, type SystemOneProvider } from '@qa/s1';
import { registerServiceRoutes } from '@qa/api';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, type Harness } from './helpers.ts';

const SHA_A = 'a'.repeat(40);
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function suite(scenarios: string[], extra: Record<string, unknown> = {}) {
  return projectConfig({
    suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios, shards: 1, concurrency: 2, signed_out_path: '/login' },
    ...extra,
  });
}

async function setup(config: Record<string, unknown>, opts: { deps?: Parameters<typeof harness>[0]['deps'] } = {}) {
  const store = new FsArtifactStore(await mkdtemp(join(tmpdir(), 'qa-art-')));
  const h = await harness({
    config,
    outDir: await mkdtemp(join(tmpdir(), 'qa-svc-')),
    deps: { artifacts: store, baselinesFor: (p: ProjectRow) => new ArtifactBaselineStore(store, `baselines/${p.tenant_id}/${p.id}`), ...opts.deps },
    api: { extend: registerServiceRoutes },
  });
  open.push(h);
  return { h, store };
}

async function app(defects: DefectId[] = [], sha = SHA_A): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: sha, defects });
  open.push(a);
  return a;
}

const call = (h: Harness, method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, body?: unknown) =>
  h.api.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });

async function deploy(h: Harness, a: FixtureApp, id: string, env = 'staging') {
  const r = await call(h, 'POST', '/v1/deployment-events', h.tokens.ci, { schema_version: 1, provider: 'pipeline', deployment_id: id, environment: env, commit_sha: SHA_A, candidate_url: a.url, ci_run_id: 1 });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}

describe.skipIf(!DATABASE_URL)('platform service (Phase 9)', () => {
  it('onboards projects and tokens with role, scope and audit enforcement', async () => {
    const { h } = await setup(suite(['viewer_cannot_create_notes']));
    const tenantAdmin = (await bootstrapProject(h.db, { tenant: { id: 'acme' }, project: { id: 'shop', config: suite(['viewer_cannot_create_notes']), repository_id: '4242', repository_full_name: 'acme/shop', webhook_secret_ref: 'SHOP_WEBHOOK_SECRET' }, tokens: [{ role: 'admin', label: 'root', project_scoped: false }] })).root!;
    const created = await call(h, 'POST', '/v1/projects', tenantAdmin, { id: 'blog', config: suite(['sign_in']) });
    expect(created.statusCode, created.body).toBe(201);
    expect((await call(h, 'POST', '/v1/projects', h.tokens.admin, { id: 'other', config: suite(['sign_in']) })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/v1/projects', tenantAdmin, { id: 'bad', config: { nope: true } })).statusCode).toBe(400);

    const minted = await call(h, 'POST', '/v1/tokens', tenantAdmin, { role: 'submitter', label: 'blog-ci', project_id: 'blog' });
    expect(minted.statusCode).toBe(201);
    const token = minted.json().token as string;
    expect(token).toMatch(/^qa_/);
    expect((await call(h, 'POST', '/v1/tokens', h.tokens.viewer, { role: 'admin', label: 'x' })).statusCode).toBe(403);
    expect((await call(h, 'POST', '/v1/tokens', h.tokens.admin, { role: 'admin', label: 'escalate', project_id: null })).statusCode).toBe(403);
    expect((await call(h, 'GET', '/v1/runs', token)).statusCode).toBe(200);
    expect((await call(h, 'DELETE', '/v1/tokens/blog-ci', tenantAdmin)).statusCode).toBe(200);
    expect((await call(h, 'GET', '/v1/runs', token)).statusCode).toBe(401);

    const audit = (await call(h, 'GET', '/v1/audit', tenantAdmin)).json() as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['project.create', 'token.create', 'token.revoke']));
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('leases fairly across tenants within each tenant quota', async () => {
    const { h } = await setup(suite(['sign_in']));
    await bootstrapProject(h.db, { tenant: { id: 'beta', max_concurrent_jobs: 2 }, project: { id: 'beta-app', config: suite(['sign_in']) } });
    await h.db.query(`update tenants set max_concurrent_jobs=1 where id='acme'`);
    // acme already has one active lease (at quota); beta has none.
    await h.db.query(`insert into jobs(tenant_id, kind, state, lease_owner, lease_expires_at) values ('acme','noop','leased','w0', now() + interval '1 hour')`);
    await h.db.query(`insert into jobs(tenant_id, kind, available_at) values ('acme','noop', now() - interval '1 minute'), ('beta','noop', now())`);
    const first = await h.worker.lease();
    expect(first!.tenant_id).toBe('beta');
    expect(await h.worker.lease()).toBeNull();
  });

  it('enforces the per-tenant System One quota atomically', async () => {
    const { h } = await setup(suite(['sign_in']));
    await h.db.query(`update tenants set s1_daily_quota=2 where id='acme'`);
    const inner: SystemOneProvider = { id: 'fake', ask: async () => ({ answers: {} }) };
    const q = new QuotaProvider(inner, h.db, 'acme');
    const req = { model: 'm', context: '{}', questions: [] };
    await q.ask(req);
    await q.ask(req);
    await expect(q.ask(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('recovers from worker loss without duplicating work and sweeps orphaned fixtures', async () => {
    const { h } = await setup(suite(['viewer_cannot_create_notes']));
    const a = await app();
    const run = await deploy(h, a, 'loss-1');
    await h.worker.processOne(); // readiness
    // A worker leased the shard and died after provisioning a fixture.
    const orphan = await new FixtureClient(a.url, FIXTURE_TOKEN).provision('viewer_v1');
    await h.db.query(`insert into cleanup_tasks(tenant_id, project_id, run_id, fixture_id, fixture_api_url) values ('acme','shop',$1,$2,$3)`, [run, orphan.fixture_id, a.url]);
    await h.db.query(`update jobs set state='leased', attempts=1, lease_owner='dead', lease_expires_at=now() - interval '1 second' where run_id=$1 and kind='execute_shard'`, [run]);
    await h.worker.drain();
    const r = (await call(h, 'GET', `/v1/runs/${run}`, h.tokens.viewer)).json();
    expect(r.run.state).toBe('COMPLETED');
    expect(r.cases).toHaveLength(1);
    expect(a.store.users.size).toBe(1); // only the orphan remains
    const report = await new Sweeper(h.orch, { env: h.env }).cleanup();
    expect(report.cleaned).toBe(1);
    expect(a.store.users.size).toBe(0);
  });

  it('alerts after repeated cleanup failures and keeps retrying', async () => {
    const { h } = await setup(suite(['sign_in']));
    const alerts: string[] = [];
    await h.db.query(`insert into cleanup_tasks(tenant_id, project_id, fixture_id, fixture_api_url) values ('acme','shop','fx_gone','http://127.0.0.1:1')`);
    const sweeper = new Sweeper(h.orch, { env: h.env, alertAfter: 2, alert: (m) => alerts.push(m) });
    for (let i = 0; i < 3; i++) {
      await h.db.query(`update cleanup_tasks set available_at=now() - interval '1 second'`);
      await sweeper.cleanup();
    }
    expect(alerts).toHaveLength(1);
    const t = (await h.db.query(`select state, attempts, alerted_at from cleanup_tasks`)).rows[0]!;
    expect(t).toMatchObject({ state: 'pending', attempts: 3 });
    expect(t.alerted_at).not.toBeNull();
  });

  it('visual review closes the loop: NEEDS_REVIEW → reviewer approval tied to the commit → PASS; regressions become deduplicated findings', async () => {
    const { h, store } = await setup(suite(['cart_quality']));
    const a = await app();
    const run = await deploy(h, a, 'vis-1');
    await h.worker.drain();
    let r = (await call(h, 'GET', `/v1/runs/${run}`, h.tokens.viewer)).json();
    expect(r.cases[0].verdict).toBe('NEEDS_REVIEW');
    expect(r.run.gate.eligible).toBe(false);
    const body = { scenario_id: 'cart_quality', execution_profile: 'chromium_desktop', checkpoint: 'cart' };
    expect((await call(h, 'POST', `/v1/baselines/${run}/approve`, h.tokens.viewer, body)).statusCode).toBe(403);
    expect((await call(h, 'POST', `/v1/baselines/${run}/approve`, h.tokens.ci, body)).statusCode).toBe(403);
    const ok = await call(h, 'POST', `/v1/baselines/${run}/approve`, h.tokens.reviewer, body);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ version: 1, commit_sha: SHA_A, approved_by: 'token:reviewer' });
    expect((await store.list('baselines/acme/shop')).length).toBe(3);

    await call(h, 'POST', `/v1/runs/${run}/retry`, h.tokens.ci, { reason: 'baseline approved' });
    await h.worker.drain();
    r = (await call(h, 'GET', `/v1/runs/${run}`, h.tokens.viewer)).json();
    expect(r.run.gate.eligible).toBe(true);

    // An unapproved visual change on a new deployment fails and is recorded once, then counted.
    a.defects.add('header_restyled');
    for (const id of ['vis-2', 'vis-3']) {
      const rid = await deploy(h, a, id);
      await h.worker.drain();
      expect((await call(h, 'GET', `/v1/runs/${rid}`, h.tokens.viewer)).json().run.gate.eligible).toBe(false);
    }
    const findings = (await call(h, 'GET', '/v1/findings?project_id=shop', h.tokens.viewer)).json() as Array<{ id: string; kind: string; occurrences: number }>;
    const visual = findings.filter((f) => f.kind === 'visual_diff');
    expect(visual).toHaveLength(1);
    expect(visual[0]!.occurrences).toBe(2);
    expect((await call(h, 'POST', `/v1/findings/${visual[0]!.id}/review`, h.tokens.reviewer, { status: 'dismissed' })).statusCode).toBe(400);
    const reviewed = await call(h, 'POST', `/v1/findings/${visual[0]!.id}/review`, h.tokens.reviewer, { status: 'accepted', note: 'real regression' });
    expect(reviewed.json()).toMatchObject({ status: 'accepted', reviewed_by: 'token:reviewer' });
  });

  it('isolates tenants, serves artifacts only to their owners, and purges them after retention', async () => {
    const { h } = await setup(suite(['viewer_cannot_create_notes'], { retention: { artifacts_days: 7 } }));
    const a = await app();
    const run = await deploy(h, a, 'ret-1');
    await h.worker.drain();
    const { cases } = (await call(h, 'GET', `/v1/runs/${run}`, h.tokens.viewer)).json();
    const events = cases[0].result.artifacts.find((x: { kind: string }) => x.kind === 'events');
    const path = `${cases[0].run_dir}/${events.path}`;
    expect((await call(h, 'GET', `/v1/runs/${run}/artifacts/${path}`, h.tokens.viewer)).statusCode).toBe(200);
    const other = await bootstrapProject(h.db, { tenant: { id: 'other' }, project: { id: 'other-app', config: suite(['sign_in']) }, tokens: [{ role: 'admin', label: 'o' }] });
    expect((await call(h, 'GET', `/v1/runs/${run}/artifacts/${path}`, other.o)).statusCode).toBe(404);
    expect((await call(h, 'GET', `/v1/runs/${run}/artifacts/../../etc/passwd`, h.tokens.viewer)).statusCode).toBe(404);
    expect((await call(h, 'GET', '/v1/findings?project_id=shop', other.o)).statusCode).toBe(404);

    const sweeper = new Sweeper(h.orch, { env: h.env });
    expect((await sweeper.retention(new Date(Date.now() + 3 * 86_400_000))).purged_runs).toBe(0);
    const purged = await sweeper.retention(new Date(Date.now() + 8 * 86_400_000));
    expect(purged.purged_runs).toBe(1);
    expect(purged.purged_files).toBeGreaterThan(0);
    expect((await call(h, 'GET', `/v1/runs/${run}/artifacts/${path}`, h.tokens.viewer)).statusCode).toBe(404);
  });

  it('dashboard: cookie session, role-aware actions and CSRF protection', async () => {
    const { h } = await setup(suite(['cart_quality']));
    const a = await app();
    const run = await deploy(h, a, 'dash-1');
    await h.worker.drain();
    expect((await h.api.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(303);
    const login = await h.api.inject({ method: 'POST', url: '/dashboard/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${encodeURIComponent(h.tokens.reviewer!)}` });
    expect(login.statusCode).toBe(303);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const list = await h.api.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(list.body).toContain(run);
    const detail = await h.api.inject({ method: 'GET', url: `/dashboard/runs/${run}`, headers: { cookie } });
    expect(detail.body).toContain('NEEDS_REVIEW');
    expect(detail.body).toContain('Approve “cart” baseline');
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(detail.body)![1]!;
    const form = (c: string) => `csrf=${c}&scenario_id=cart_quality&execution_profile=chromium_desktop&checkpoint=cart`;
    const forged = await h.api.inject({ method: 'POST', url: `/dashboard/runs/${run}/approve-baseline`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: form('0'.repeat(64)) });
    expect(forged.statusCode).toBe(403);
    const approved = await h.api.inject({ method: 'POST', url: `/dashboard/runs/${run}/approve-baseline`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: form(csrf) });
    expect(approved.statusCode).toBe(303);
    const img = /href="(\/dashboard\/artifacts\/[^"]+\.png)"/.exec(detail.body)![1]!;
    const shot = await h.api.inject({ method: 'GET', url: img, headers: { cookie } });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');

    const viewerLogin = await h.api.inject({ method: 'POST', url: '/dashboard/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${encodeURIComponent(h.tokens.viewer!)}` });
    const viewerCookie = String(viewerLogin.headers['set-cookie']).split(';')[0]!;
    expect((await h.api.inject({ method: 'GET', url: `/dashboard/runs/${run}`, headers: { cookie: viewerCookie } })).body).not.toContain('Approve');
  });

  it('production uses the read-only profile: only fixture-less, non-mutating checks are selected and run', async () => {
    const config = suite(['production_smoke', 'checkout_existing_customer'], {
      environments: { production: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true, read_only: true } },
      fixture_api: { token_env: 'NOT_SET_IN_PRODUCTION' },
    });
    const { h } = await setup(config);
    const a = await app();
    const run = await deploy(h, a, 'prod-1', 'production');
    await h.worker.drain();
    const r = (await call(h, 'GET', `/v1/runs/${run}`, h.tokens.viewer)).json();
    expect(r.run.selection_manifest.cases.map((c: { scenario_id: string }) => c.scenario_id)).toEqual(['production_smoke']);
    expect(r.run.selection_manifest.omitted.map((o: { scenario_id: string }) => o.scenario_id)).toContain('checkout_existing_customer');
    expect(r.run.selection_manifest.explanation).toContain('read-only capability profile applied');
    expect(r.run.gate.eligible).toBe(true);
    expect(a.store.users.size).toBe(0);
    expect((await h.db.query('select count(*)::int n from cleanup_tasks')).rows[0]!.n).toBe(0);
  });

  it('accepts a signed Vercel deployment.ready webhook verified against the Vercel API', async () => {
    const a = await app();
    const vercelApi = createServer((req, res) => {
      if (req.url?.startsWith('/v13/deployments/dpl_1')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'dpl_1', url: 'shop-git-x.vercel.app', readyState: 'READY', target: null, meta: { githubCommitSha: SHA_A } }));
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => vercelApi.listen(0, '127.0.0.1', () => r()));
    open.push({ close: () => new Promise<void>((r) => vercelApi.close(() => r())) });
    const vercel = new VercelClient('vtok', { apiUrl: `http://127.0.0.1:${(vercelApi.address() as AddressInfo).port}` });
    const config = suite(['sign_in'], { environments: { preview: { url_patterns: ['https://*.vercel.app'] } } });
    const { h } = await setup(config, {
      deps: {
        resolveHost: async () => ['76.76.21.21'],
        verifierFor: (_p, provider) => (provider === 'vercel' ? new VercelDeploymentVerifier(vercel) : provider === 'github' ? new GitHubDeploymentVerifier(new GitHubClient(new StaticTokenProvider('x'), 'http://127.0.0.1:1')) : new PipelineDeploymentVerifier()),
      },
    });
    const body = JSON.stringify({ id: 'evt_1', type: 'deployment.ready', payload: { deployment: { id: 'dpl_1', url: 'shop-git-x.vercel.app', meta: { githubCommitSha: SHA_A } }, target: null } });
    const sig = createHmac('sha1', 'webhook-secret-for-tests').update(body).digest('hex');
    const bad = await h.api.inject({ method: 'POST', url: '/v1/webhooks/vercel/shop', headers: { 'content-type': 'application/json', 'x-vercel-signature': '0'.repeat(40) }, payload: body });
    expect(bad.statusCode).toBe(401);
    const res = await h.api.inject({ method: 'POST', url: '/v1/webhooks/vercel/shop', headers: { 'content-type': 'application/json', 'x-vercel-signature': sig }, payload: body });
    expect(res.statusCode, res.body).toBe(202);
    const dep = (await h.db.query(`select provider, provider_deployment_id, immutable_url, commit_sha from deployments`)).rows[0];
    expect(dep).toEqual({ provider: 'vercel', provider_deployment_id: 'dpl_1', immutable_url: 'https://shop-git-x.vercel.app', commit_sha: SHA_A });
    void a;
  });
});
