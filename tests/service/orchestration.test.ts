import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type DefectId, type FixtureApp } from '@qa/fixture-test-app';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, sign, type Harness } from './helpers.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SMALL = projectConfig({
  suite: {
    specs_dir: 'specs',
    policy_file: 'specs/policies/fixture-shop.yaml',
    fixture_catalog: 'specs/fixtures.yaml',
    profiles: ['chromium_desktop'],
    scenarios: ['checkout_existing_customer', 'viewer_cannot_create_notes', 'sign_in'],
    shards: 2,
    concurrency: 2,
    signed_out_path: '/login',
  },
});

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function setup(config: Record<string, unknown> = SMALL, extra: Partial<Parameters<typeof harness>[0]> = {}): Promise<Harness> {
  const h = await harness({ config, outDir: await mkdtemp(join(tmpdir(), 'qa-svc-')), ...extra });
  open.push(h);
  return h;
}

async function app(sha: string, defects: DefectId[] = []): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: sha, defects });
  open.push(a);
  return a;
}

const submit = (h: Harness, body: Record<string, unknown>, token = h.tokens.ci!) =>
  h.api.inject({ method: 'POST', url: '/v1/deployment-events', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

function githubEvent(id: number, sha: string, env = 'preview', url?: string) {
  return { schema_version: 1, provider: 'github', repository_id: 4242, deployment_id: id, deployment_status_id: id * 10, environment: env, commit_sha: sha, candidate_url: url ?? null, ci_run_id: 1 };
}

const getRun = async (h: Harness, id: string, token = h.tokens.viewer!) => (await h.api.inject({ method: 'GET', url: `/v1/runs/${id}`, headers: { authorization: `Bearer ${token}` } })).json();
const gate = async (h: Harness, deploymentId: string, sha: string) =>
  (await h.api.inject({ method: 'GET', url: `/v1/gate?project_id=shop&environment=preview&deployment_id=${deploymentId}&commit_sha=${sha}`, headers: { authorization: `Bearer ${h.tokens.viewer}` } })).json();

describe.skipIf(!DATABASE_URL)('deployment-triggered orchestration', () => {
  it('a signed webhook launches the suite, publishes the exact-SHA check, and the gate opens', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(101, SHA_A, 'preview', a.url);
    const body = JSON.stringify({ repository: { id: 4242 }, sender: { login: 'github-actions[bot]' }, deployment: { id: 101, sha: SHA_A, environment: 'preview' }, deployment_status: { id: 1010, state: 'success', environment_url: a.url } });
    const res = await h.api.inject({ method: 'POST', url: '/v1/webhooks/github', headers: { 'content-type': 'application/json', 'x-github-event': 'deployment_status', 'x-hub-signature-256': sign(body) }, payload: body });
    expect(res.statusCode).toBe(202);
    const { run_id, note } = res.json();
    expect(note).toMatch(/not a QA result/);
    expect(h.gh.commitStatuses).toHaveLength(0);
    await h.worker.drain();

    const { run, cases } = await getRun(h, run_id);
    expect(run.state).toBe('COMPLETED');
    expect(run.gate).toEqual({ eligible: true, reasons: [] });
    expect(cases.map((c: { verdict: string }) => c.verdict)).toEqual(['PASS', 'PASS', 'PASS']);
    const statuses = h.gh.commitStatuses.filter((s) => s.sha === SHA_A);
    expect(statuses[0]!).toMatchObject({ state: 'pending', context: 'autonomous-qa/shop/preview/required', repo: 'acme/shop' });
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'success', target_url: `https://qa.example.test/runs/${run_id}` });
    expect(await gate(h, '101', SHA_A)).toMatchObject({ eligible: true, run_id });
    // All test-owned fixtures were cleaned up and the obligations recorded as done.
    const tasks = (await h.db.query(`select state from cleanup_tasks where run_id=$1`, [run_id])).rows;
    expect(tasks.length).toBe(3);
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
  });

  it('rejects a webhook with a bad signature and creates nothing', async () => {
    const h = await setup();
    const body = JSON.stringify({ repository: { id: 4242 }, deployment: { id: 1, sha: SHA_A, environment: 'preview' }, deployment_status: { id: 2, state: 'success' } });
    const res = await h.api.inject({ method: 'POST', url: '/v1/webhooks/github', headers: { 'content-type': 'application/json', 'x-github-event': 'deployment_status', 'x-hub-signature-256': sign(body, 'wrong') }, payload: body });
    expect(res.statusCode).toBe(401);
    expect((await h.db.query('select count(*)::int n from runs')).rows[0]!.n).toBe(0);
  });

  it('ten duplicate deliveries create exactly one logical run', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(102, SHA_A, 'preview', a.url);
    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(h, githubEvent(102, SHA_A))));
    const ids = new Set(responses.map((r) => r.json().run_id));
    expect(responses.every((r) => [200, 202].includes(r.statusCode))).toBe(true);
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.statusCode === 202)).toHaveLength(1);
    // A different delivery for the same deployment (e.g. webhook + workflow) also maps to the same run.
    const again = await submit(h, { ...githubEvent(102, SHA_A), deployment_status_id: 999 });
    expect(again.json()).toMatchObject({ run_id: [...ids][0], deduplicated: true });
    expect((await h.db.query('select count(*)::int n from runs')).rows[0]!.n).toBe(1);
    expect((await h.db.query(`select count(*)::int n from jobs where kind='readiness'`)).rows[0]!.n).toBe(1);
  });

  it('rejects a claim that disagrees with trusted provider metadata', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(103, SHA_A, 'preview', a.url);
    const res = await submit(h, githubEvent(103, SHA_B));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'deployment_unverified' });
    expect(JSON.stringify(res.json().detail)).toMatch(/sha_matches/);
    const wrongUrl = await submit(h, { ...githubEvent(103, SHA_A), deployment_status_id: 31, candidate_url: 'http://127.0.0.1:1' });
    expect(wrongUrl.statusCode).toBe(422);
    expect((await h.db.query('select count(*)::int n from runs')).rows[0]!.n).toBe(0);
  });

  it('rejects URLs outside the environment policy', async () => {
    const h = await setup(projectConfig({ environments: { preview: { url_patterns: ['https://*.preview.example.dev'] } } }));
    h.gh.deploy(104, SHA_A, 'preview', 'http://127.0.0.1:9');
    const res = await submit(h, githubEvent(104, SHA_A));
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/matches no configured pattern/);
    const unknownEnv = await submit(h, { ...githubEvent(104, SHA_A, 'production'), deployment_status_id: 77 });
    expect(unknownEnv.json()).toMatchObject({ error: 'environment_not_configured' });
  });

  it('blocks execution when the target serves a different revision', async () => {
    const h = await setup();
    const a = await app(SHA_B);
    h.gh.deploy(105, SHA_A, 'preview', a.url);
    const { run_id } = (await submit(h, githubEvent(105, SHA_A))).json();
    await h.worker.drain();
    const { run, cases } = await getRun(h, run_id);
    expect(run).toMatchObject({ state: 'ERROR', reason: 'version_drift' });
    expect(cases).toHaveLength(0);
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'error' });
    expect((await gate(h, '105', SHA_A)).eligible).toBe(false);
  });

  it("deployment A's late result can never approve deployment B", async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const b = await app(SHA_B);
    h.gh.deploy(201, SHA_A, 'preview', a.url);
    h.gh.deploy(202, SHA_B, 'preview', b.url);
    const runA = (await submit(h, githubEvent(201, SHA_A))).json().run_id;
    const runB = (await submit(h, githubEvent(202, SHA_B))).json().run_id;
    await h.worker.drain();
    expect((await getRun(h, runA)).run).toMatchObject({ state: 'SUPERSEDED', superseded_by: runB });
    expect((await getRun(h, runB)).run.state).toBe('COMPLETED');
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'error' });
    expect(h.gh.latest(SHA_B)!).toMatchObject({ state: 'success' });
    expect((await gate(h, '201', SHA_A)).eligible).toBe(false);
    expect((await gate(h, '202', SHA_A)).eligible).toBe(false);
    expect((await gate(h, '202', SHA_B)).eligible).toBe(true);
    // Retrying the superseded deployment is refused.
    const retry = await h.api.inject({ method: 'POST', url: `/v1/runs/${runA}/retry`, headers: { authorization: `Bearer ${h.tokens.ci}`, 'content-type': 'application/json' }, payload: '{"reason":"x"}' });
    expect(retry.statusCode).toBe(409);
  });

  it('a permanently failed shard holds the gate as a missing result', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(106, SHA_A, 'preview', a.url);
    const { run_id } = (await submit(h, githubEvent(106, SHA_A))).json();
    await h.worker.processOne(); // readiness → shards queued
    await h.db.query(`update jobs set max_attempts=1, available_at=now() where run_id=$1 and kind='execute_shard' and (payload->>'shard')::int=1`, [run_id]);
    // Simulate a shard whose worker keeps dying: its lease expires with attempts exhausted.
    await h.db.query(`update jobs set state='leased', attempts=1, lease_owner='dead-worker', lease_expires_at=now() - interval '1 second' where run_id=$1 and kind='execute_shard' and (payload->>'shard')::int=1`, [run_id]);
    await h.worker.drain();
    const { run } = await getRun(h, run_id);
    expect(run.state).toBe('COMPLETED');
    expect(run.gate.eligible).toBe(false);
    expect(run.gate.reasons.join('\n')).toMatch(/missing result/);
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'failure' });
  });

  it('a seeded defect: submission is accepted, but QA fails and the check is red', async () => {
    const h = await setup();
    const a = await app(SHA_A, ['total_off_by_one']);
    h.gh.deploy(107, SHA_A, 'preview', a.url);
    const res = await submit(h, githubEvent(107, SHA_A));
    expect(res.statusCode).toBe(202);
    await h.worker.drain();
    const { run } = await getRun(h, res.json().run_id);
    expect(run.gate.eligible).toBe(false);
    expect(run.gate.reasons.join()).toMatch(/checkout_existing_customer@chromium_desktop: FAIL/);
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'failure' });
  });

  it('cancellation stops the run, publishes an error status, and a retry is a new attempt that keeps history', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(108, SHA_A, 'preview', a.url);
    const { run_id } = (await submit(h, githubEvent(108, SHA_A))).json();
    const cancel = await h.api.inject({ method: 'POST', url: `/v1/runs/${run_id}/cancel`, headers: { authorization: `Bearer ${h.tokens.ci}` } });
    expect(cancel.json().run.state).toBe('CANCELLED');
    await h.worker.drain();
    expect(h.gh.latest(SHA_A)!).toMatchObject({ state: 'error', description: 'QA run cancelled' });

    const noReason = await h.api.inject({ method: 'POST', url: `/v1/runs/${run_id}/retry`, headers: { authorization: `Bearer ${h.tokens.ci}`, 'content-type': 'application/json' }, payload: '{}' });
    expect(noReason.statusCode).toBe(400);
    const retry = await h.api.inject({ method: 'POST', url: `/v1/runs/${run_id}/retry`, headers: { authorization: `Bearer ${h.tokens.ci}`, 'content-type': 'application/json' }, payload: '{"reason":"cancelled by mistake"}' });
    expect(retry.json().run).toMatchObject({ attempt: 2, state: 'WAITING_READY' });
    await h.worker.drain();
    const { run, cases } = await getRun(h, run_id);
    expect(run).toMatchObject({ state: 'COMPLETED', attempt: 2 });
    expect(cases.every((c: { attempt: number }) => c.attempt === 2)).toBe(true);
    const audit = (await h.db.query(`select action from audit_log where subject=$1 order by id`, [run_id])).rows.map((r) => r.action);
    expect(audit).toEqual(['run.created', 'run.cancel', 'run.retry']);
  });

  it('cancelling a running shard aborts it and still cleans up fixtures', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(109, SHA_A, 'preview', a.url);
    const { run_id } = (await submit(h, githubEvent(109, SHA_A))).json();
    await h.worker.processOne(); // readiness
    const shardRun = h.worker.processOne(); // starts executing a shard
    await new Promise((r) => setTimeout(r, 300));
    await h.api.inject({ method: 'POST', url: `/v1/runs/${run_id}/cancel`, headers: { authorization: `Bearer ${h.tokens.ci}` } });
    await shardRun;
    await h.worker.drain();
    const { run } = await getRun(h, run_id);
    expect(run.state).toBe('CANCELLED');
    expect(a.store.users.size).toBe(0);
  });

  it('enforces authentication, roles and tenant isolation', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    h.gh.deploy(110, SHA_A, 'preview', a.url);
    expect((await submit(h, githubEvent(110, SHA_A), 'nope')).statusCode).toBe(401);
    expect((await submit(h, githubEvent(110, SHA_A), h.tokens.viewer)).statusCode).toBe(403);
    const { run_id } = (await submit(h, githubEvent(110, SHA_A))).json();
    const { bootstrapProject } = await import('@qa/orchestrator');
    const other = await bootstrapProject(h.db, { tenant: { id: 'other' }, project: { id: 'other-app', config: projectConfig() }, tokens: [{ role: 'admin', label: 'other-admin' }] });
    const res = await h.api.inject({ method: 'GET', url: `/v1/runs/${run_id}`, headers: { authorization: `Bearer ${other['other-admin']}` } });
    expect(res.statusCode).toBe(404);
    const cancel = await h.api.inject({ method: 'POST', url: `/v1/runs/${run_id}/cancel`, headers: { authorization: `Bearer ${h.tokens.viewer}` } });
    expect(cancel.statusCode).toBe(403);
  });

  it('pipeline submissions bind URL and SHA through the readiness revision check', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const ok = await submit(h, { schema_version: 1, provider: 'pipeline', deployment_id: 'pipe-1', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url, ci_run_id: 7 });
    expect(ok.statusCode).toBe(202);
    const liar = await submit(h, { schema_version: 1, provider: 'pipeline', deployment_id: 'pipe-2', environment: 'preview', commit_sha: SHA_B, candidate_url: a.url, ci_run_id: 8 });
    await h.worker.drain();
    expect((await getRun(h, ok.json().run_id)).run.state).toBe('COMPLETED');
    expect((await getRun(h, liar.json().run_id)).run).toMatchObject({ state: 'ERROR', reason: 'version_drift' });
  });
});

describe.skipIf(!DATABASE_URL)('change-aware selection in the service', () => {
  it('first run is full (no baseline); a notes-only change runs notes coverage plus smoke', async () => {
    const { impactSelector } = await import('@qa/orchestrator');
    const { GitHubDiffProvider } = await import('@qa/coverage');
    const { GitHubClient, StaticTokenProvider } = await import('@qa/integrations');
    const { ROOT } = await import('./helpers.ts');
    let gh!: Harness['gh'];
    const config = projectConfig({
      suite: {
        specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', coverage_file: 'specs/coverage.yaml',
        profiles: ['chromium_desktop'], scenarios: ['checkout_existing_customer', 'notes_crud', 'settings_preference_persists'], shards: 1, concurrency: 3, signed_out_path: '/login',
      },
    });
    const h = await setup(config, {
      deps: { select: impactSelector({ baseDir: ROOT, diffFor: (ctx) => new GitHubDiffProvider(new GitHubClient(new StaticTokenProvider('gh-test-token'), gh.url), ctx.project.repository_full_name!) }) },
    });
    gh = h.gh;
    const a = await app(SHA_A);
    h.gh.deploy(301, SHA_A, 'preview', a.url);
    const first = (await submit(h, githubEvent(301, SHA_A))).json().run_id;
    await h.worker.drain();
    const r1 = (await getRun(h, first)).run;
    expect(r1.selection_manifest.strategy).toBe('full');
    expect(r1.selection_manifest.gaps).toContainEqual(expect.objectContaining({ kind: 'missing_comparison' }));
    expect(r1.gate.eligible).toBe(true);

    const b = await app(SHA_B);
    h.gh.deploy(302, SHA_B, 'preview', b.url);
    h.gh.compares.set(`${SHA_A}...${SHA_B}`, { status: 'ahead', files: [{ filename: 'src/notes/list.ts', status: 'modified' }] });
    const second = (await submit(h, githubEvent(302, SHA_B))).json().run_id;
    await h.worker.drain();
    const r2 = (await getRun(h, second)).run;
    expect(r2.selection_manifest.strategy).toBe('impact');
    expect(r2.selection_manifest.cases.map((c: { scenario_id: string }) => c.scenario_id).sort()).toEqual(['checkout_existing_customer', 'notes_crud']);
    expect(r2.selection_manifest.omitted).toContainEqual({ scenario_id: 'settings_preference_persists', reason: expect.stringMatching(/no impacted requirement/) });
    expect(r2.gate.eligible).toBe(true);
  });
});
