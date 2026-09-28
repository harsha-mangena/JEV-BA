import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '@qa/fixture-test-app';
import { JobWorker } from '@qa/orchestrator';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, type Harness } from './helpers.ts';

/**
 * Execution snapshots, run lineage and single-use promotion decisions
 * (audit F05 and completion phase 7).
 */
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const CONFIG = projectConfig({
  suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios: ['sign_in'], shards: 1, concurrency: 1, signed_out_path: '/login' },
});

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function setup(): Promise<Harness> {
  const h = await harness({ config: CONFIG, outDir: await mkdtemp(join(tmpdir(), 'qa-prom-')) });
  open.push(h);
  return h;
}
async function app(sha: string): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: sha });
  open.push(a);
  return a;
}
const call = (h: Harness, method: 'GET' | 'POST', url: string, body?: unknown, token = h.tokens.ci!) =>
  h.api.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
const event = (id: string, sha: string, url: string, ci = 1) => ({ schema_version: 1, provider: 'pipeline', deployment_id: id, environment: 'staging', commit_sha: sha, candidate_url: url, ci_run_id: ci });
async function deploy(h: Harness, id: string, sha: string, url: string): Promise<string> {
  const r = await call(h, 'POST', '/v1/deployment-events', event(id, sha, url));
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}
const decide = async (h: Harness, deployment: string, sha: string) => (await call(h, 'POST', '/v1/promotions', { project_id: 'shop', environment: 'staging', deployment_id: deployment, commit_sha: sha })).json();
const consume = (h: Harness, id: string) => call(h, 'POST', `/v1/promotions/${id}/consume`, {});

describe.skipIf(!DATABASE_URL)('execution snapshot, lineage and promotion (completion phase 7)', () => {
  it('rejects a reused delivery id carrying a different payload', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const first = await call(h, 'POST', '/v1/deployment-events', event('d-1', SHA_A, a.url), undefined);
    expect(first.statusCode).toBe(202);
    const same = await call(h, 'POST', '/v1/deployment-events', event('d-1', SHA_A, a.url));
    expect(same.statusCode).toBe(200);
    const altered = await h.api.inject({ method: 'POST', url: '/v1/deployment-events', headers: { authorization: `Bearer ${h.tokens.ci}`, 'content-type': 'application/json', 'idempotency-key': 'pipeline:d-1:1' }, payload: JSON.stringify({ ...event('d-1', SHA_A, a.url), candidate_url: `${a.url}/` }) });
    expect(altered.statusCode).toBe(409);
    expect(altered.json().error ?? altered.json().code ?? altered.body).toMatch(/delivery_payload_mismatch/);
    expect((await h.db.one<{ n: number }>('select count(*)::int n from runs'))!.n).toBe(1);
  });

  it('records the execution snapshot and a monotonic generation per environment', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const b = await app(SHA_B);
    const r1 = await deploy(h, 'd-1', SHA_A, a.url);
    const r2 = await deploy(h, 'd-2', SHA_B, b.url);
    const rows = (await h.db.query<{ id: string; generation: string; execution_snapshot: { required_profiles: string[]; engine: string }; suite_revision: string }>('select id, generation::text, execution_snapshot, suite_revision from runs order by generation')).rows;
    expect(rows.map((r) => [r.id, r.generation])).toEqual([[r1, '1'], [r2, '2']]);
    expect(rows[0]!.execution_snapshot.required_profiles).toEqual(['chromium_desktop']);
    expect(rows[0]!.execution_snapshot.engine).toMatch(/^engine-/);
  });

  it('a promotion decision is consumed exactly once and only while the gate still holds for the same run', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    await deploy(h, 'd-1', SHA_A, a.url);
    await h.worker.drain();

    const d1 = await decide(h, 'd-1', SHA_A);
    expect(d1).toMatchObject({ eligible: true, reasons: [] });
    const ok = await consume(h, d1.decision_id);
    expect(ok.json()).toMatchObject({ promoted: true, reasons: [] });
    expect((await consume(h, d1.decision_id)).statusCode).toBe(409);

    // Expired decisions are refused.
    const d2 = await decide(h, 'd-1', SHA_A);
    await h.db.query(`update promotion_decisions set expires_at = now() - interval '1 second' where id=$1`, [d2.decision_id]);
    expect((await consume(h, d2.decision_id)).json()).toMatchObject({ promoted: false, reasons: ['the decision has expired'] });

    // A decision taken before a newer deployment cannot promote once that deployment exists.
    const d3 = await decide(h, 'd-1', SHA_A);
    const c = await app(SHA_C);
    await deploy(h, 'd-3', SHA_C, c.url);
    const refused = (await consume(h, d3.decision_id)).json();
    expect(refused.promoted).toBe(false);
    expect(refused.reasons.join('; ')).toMatch(/not the current candidate|newer run generation/);

    // Ineligible decisions are recorded and refused, never promoted.
    const d4 = await decide(h, 'd-1', SHA_A);
    expect(d4.eligible).toBe(false);
    expect((await consume(h, d4.decision_id)).json()).toMatchObject({ promoted: false });
    const audit = (await h.db.query<{ action: string }>(`select action from audit_log where action like 'promotion.%' order by id`)).rows.map((r) => r.action);
    expect(audit.filter((x) => x === 'promotion.consume')).toHaveLength(4);
  });

  it('expanding the required profile set after a decision refuses the promotion (audit F05b)', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    await deploy(h, 'd-1', SHA_A, a.url);
    await h.worker.drain();
    const d = await decide(h, 'd-1', SHA_A);
    expect(d.eligible).toBe(true);
    const expanded = structuredClone(CONFIG) as { suite: { profiles: string[] } };
    expanded.suite.profiles.push('chromium_mobile_viewport');
    await h.db.query(`update projects set config=$1 where id='shop'`, [JSON.stringify(expanded)]);
    const r = (await consume(h, d.decision_id)).json();
    expect(r.promoted).toBe(false);
    expect(r.reasons.join('; ')).toMatch(/suite or policy changed/);
  });

  it('publishes each run status in order: concurrent publishers never regress a newer status', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const run = await deploy(h, 'd-1', SHA_A, a.url);
    await h.worker.drain();
    await h.db.query(`insert into outbox_events(tenant_id, kind, payload) select 'acme', 'publish_status', $1 from generate_series(1, 8)`, [JSON.stringify({ run_id: run })]);
    const before = h.publisher.published.length;
    const publishers = [h.worker, new JobWorker(h.orch, { outDir: tmpdir(), workerId: 'p2' }), new JobWorker(h.orch, { outDir: tmpdir(), workerId: 'p3' })];
    await Promise.all(publishers.map((w) => w.publishOutbox(3)));
    await h.worker.drain();
    expect((await h.db.one<{ n: number }>('select count(*)::int n from outbox_events where published_at is null'))!.n).toBe(0);
    const after = h.publisher.published.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(8); // coalesced
    expect(after.every((s) => s.state === 'success')).toBe(true);
  });
});
