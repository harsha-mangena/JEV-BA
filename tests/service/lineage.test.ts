import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '@qa/fixture-test-app';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, type Harness } from './helpers.ts';

/**
 * Re-audit R3 on PostgreSQL: deployment lineages (channels) and authoritative
 * ordering. Sibling previews are independent lineages; ordering comes from
 * verified provider state, so an old event that arrives late never becomes
 * the candidate; ties hold the lineage; generations are serialized per
 * lineage; a candidate registered during a promotion consume is either fully
 * before or fully after it; and a late status for a replaced deployment of the
 * same commit never overwrites the current candidate's status.
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function config() {
  const c = projectConfig({ suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios: ['sign_in'], shards: 1, concurrency: 1, signed_out_path: '/login' } });
  (c.environments.preview as Record<string, unknown>).lineage = 'per_channel';
  return c;
}

async function setup(): Promise<Harness> {
  const h = await harness({ config: config(), outDir: await mkdtemp(join(tmpdir(), 'qa-lin-')) });
  open.push(h);
  return h;
}

async function app(sha: string): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: sha });
  open.push(a);
  return a;
}

const call = (h: Harness, token: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  h.api.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });

const submit = (h: Harness, e: Record<string, unknown>) => call(h, h.tokens.ci!, 'POST', '/v1/deployment-events', { schema_version: 1, provider: 'pipeline', ci_run_id: String(e.deployment_id), ...e });

async function deployed(h: Harness, e: Record<string, unknown>): Promise<string> {
  const r = await submit(h, e);
  expect([200, 202], r.body).toContain(r.statusCode);
  return r.json().run_id as string;
}

const gate = async (h: Harness, env: string, id: string, sha: string) =>
  (await call(h, h.tokens.viewer!, 'GET', `/v1/gate?${new URLSearchParams({ project_id: 'shop', environment: env, deployment_id: id, commit_sha: sha })}`)).json() as { eligible: boolean; run_id: string | null; reasons: string[] };
const decide = async (h: Harness, env: string, id: string, sha: string) => (await call(h, h.tokens.ci!, 'POST', '/v1/promotions', { project_id: 'shop', environment: env, deployment_id: id, commit_sha: sha })).json();
const consume = async (h: Harness, decision: string) => (await call(h, h.tokens.ci!, 'POST', `/v1/promotions/${decision}/consume`, {})).json();
const runState = async (h: Harness, id: string) => (await h.db.one<{ state: string; channel: string; generation: string | null }>('select state, channel, generation::text from runs where id=$1', [id]))!;

describe.skipIf(!DATABASE_URL)('deployment lineage and ordering (re-audit R3)', () => {
  it('sibling pull-request previews are independent lineages; a preview without a verifiable channel is refused', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const b = await app(SHA_B);
    const r1 = await deployed(h, { deployment_id: 'pr1-1', environment: 'preview', commit_sha: SHA_A, candidate_url: a.url, channel: 'pr:1' });
    const r2 = await deployed(h, { deployment_id: 'pr2-1', environment: 'preview', commit_sha: SHA_B, candidate_url: b.url, channel: 'pr:2' });
    await h.worker.drain();
    expect(await runState(h, r1)).toEqual({ state: 'COMPLETED', channel: 'pr:1', generation: '1' });
    expect(await runState(h, r2)).toEqual({ state: 'COMPLETED', channel: 'pr:2', generation: '1' });
    // PR 1's decision survives PR 2's deployment: different lineage, different generation counter.
    const d1 = await decide(h, 'preview', 'pr1-1', SHA_A);
    await deployed(h, { deployment_id: 'pr2-2', environment: 'preview', commit_sha: SHA_B, candidate_url: b.url, channel: 'pr:2' });
    expect(await consume(h, d1.decision_id)).toMatchObject({ promoted: true, channel: 'pr:1', generation: 1, deployment_id: 'pr1-1' });
    // Within PR 2 the newer deployment supersedes the older one.
    expect((await gate(h, 'preview', 'pr2-1', SHA_B)).reasons).toContain('deployment pr2-1 is not the current candidate (pr2-2)');

    const refused = await submit(h, { deployment_id: 'nochan', environment: 'preview', commit_sha: SHA_A, candidate_url: a.url });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code ?? refused.json().error).toMatch(/channel_unverified/);
  });

  it('an older provider event that arrives after a newer one is recorded but never becomes the candidate', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const b = await app(SHA_B);
    // GitHub deployment ids are the provider's order: 200 is newer than 100, whatever order the events arrive in.
    h.gh.deploy(200, SHA_B, 'staging', b.url);
    h.gh.deploy(100, SHA_A, 'staging', a.url);
    const newer = await deployed(h, { provider: 'github', repository_id: 4242, deployment_id: 200, deployment_status_id: 2000, environment: 'staging', commit_sha: SHA_B, candidate_url: b.url });
    const older = await submit(h, { provider: 'github', repository_id: 4242, deployment_id: 100, deployment_status_id: 1000, environment: 'staging', commit_sha: SHA_A, candidate_url: a.url });
    expect(older.statusCode).toBe(202);
    expect(older.json().note).toMatch(/not tested: older than the current candidate 200 by provider ordering \(100 < 200\)/);
    expect(await runState(h, older.json().run_id)).toMatchObject({ state: 'SUPERSEDED', generation: null });
    await h.worker.drain();
    expect(await runState(h, newer)).toMatchObject({ state: 'COMPLETED', generation: '1' });
    expect(await gate(h, 'staging', '200', SHA_B)).toMatchObject({ eligible: true, reasons: [] });
    const old = await gate(h, 'staging', '100', SHA_A);
    expect(old.eligible).toBe(false);
    expect(old.reasons).toContain('deployment 100 is not the current candidate (200)');
    expect((await decide(h, 'staging', '100', SHA_A)).eligible).toBe(false);
    expect((await h.db.one<{ outcome: string }>(`select outcome from event_deliveries where delivery_id='status:1000'`))!.outcome).toBe('stale');
  });

  it('a provider-order tie holds the lineage until a strictly newer deployment arrives; mixing ordering kinds is refused', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    await deployed(h, { deployment_id: 't-1', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url, sequence: 5 });
    const tie = await submit(h, { deployment_id: 't-2', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url, sequence: 5 });
    expect(tie.json().note).toMatch(/lineage is held: deployment t-1 and this deployment have no strict provider order/);
    await h.worker.drain();
    for (const id of ['t-1', 't-2']) expect((await gate(h, 'staging', id, SHA_A)).reasons.join('\n')).toMatch(/order of candidates in lineage default is ambiguous/);
    const mixed = await submit(h, { deployment_id: 't-x', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url });
    expect(mixed.statusCode).toBe(422);
    await deployed(h, { deployment_id: 't-3', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url, sequence: 6 });
    await h.worker.drain();
    expect(await gate(h, 'staging', 't-3', SHA_A)).toMatchObject({ eligible: true, reasons: [] });
  });

  it('concurrent distinct submissions get distinct, gapless generations and exactly one current candidate', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const ids = Array.from({ length: 8 }, (_, i) => `c-${i}`);
    const rs = await Promise.all(ids.map((id) => submit(h, { deployment_id: id, environment: 'staging', commit_sha: SHA_A, candidate_url: a.url })));
    expect(rs.map((r) => r.statusCode)).toEqual(ids.map(() => 202));
    const rows = (await h.db.query<{ generation: string; state: string; deployment_id: string }>(`select generation::text, state, deployment_id from runs where project_id='shop' and environment='staging' order by generation`)).rows;
    expect(rows.map((r) => r.generation)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    const ch = (await h.db.one<{ generation: string; current_deployment_id: string }>(`select generation::text, current_deployment_id from deployment_channels where project_id='shop' and environment='staging'`))!;
    expect(ch.generation).toBe('8');
    // The newest generation belongs to the current candidate; every older unfinished run was superseded.
    expect(rows.at(-1)!.deployment_id).toBe(ch.current_deployment_id);
    expect(rows.slice(0, -1).every((r) => r.state === 'SUPERSEDED')).toBe(true);
  });

  it('a candidate registered while a decision is consumed lands entirely before or entirely after the consume', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      await deployed(h, { deployment_id: `r-${i}`, environment: 'staging', commit_sha: SHA_A, candidate_url: a.url });
      await h.worker.drain();
      const d = await decide(h, 'staging', `r-${i}`, SHA_A);
      expect(d.eligible, JSON.stringify(d)).toBe(true);
      const [c] = await Promise.all([consume(h, d.decision_id), submit(h, { deployment_id: `r-${i}-next`, environment: 'staging', commit_sha: SHA_A, candidate_url: a.url })]);
      const order = (await h.db.query<{ action: string }>(`select action from audit_log where (action='promotion.consume' and subject=$1) or (action='run.created' and detail->>'deployment'=$2) order by id`, [d.decision_id, `r-${i}-next`])).rows.map((r) => r.action);
      if (c.promoted) expect(order).toEqual(['promotion.consume', 'run.created']);
      else {
        expect(order).toEqual(['run.created', 'promotion.consume']);
        expect(c.reasons.join('\n')).toMatch(/not the current candidate|newest generation/);
      }
      outcomes.push(c.promoted ? 'promoted-before' : 'refused-after');
      await h.worker.drain();
    }
    expect(outcomes).toHaveLength(5);
  });

  it('a late status for a replaced deployment of the same commit never overwrites the current candidate status', async () => {
    const h = await setup();
    const a = await app(SHA_A);
    const r1 = await deployed(h, { deployment_id: 's-1', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url });
    await h.worker.drain();
    const context = 'autonomous-qa/shop/staging/required';
    expect(h.publisher.latest(SHA_A, context)?.state).toBe('success');
    const d1 = await decide(h, 'staging', 's-1', SHA_A);
    await deployed(h, { deployment_id: 's-2', environment: 'staging', commit_sha: SHA_A, candidate_url: a.url });
    await h.worker.publishOutbox();
    expect(h.publisher.latest(SHA_A, context)?.state).toBe('pending');
    // The replaced deployment's status is published late (e.g. a retried outbox event).
    await h.db.query(`insert into outbox_events(tenant_id, kind, payload) values ('acme','publish_status',$1)`, [JSON.stringify({ run_id: r1 })]);
    await h.worker.publishOutbox();
    expect(h.publisher.latest(SHA_A, context)?.state).toBe('pending');
    // Same commit, but the old deployment's decision cannot promote.
    expect((await consume(h, d1.decision_id)).promoted).toBe(false);
    await h.worker.drain();
    expect(h.publisher.latest(SHA_A, context)?.state).toBe('success');
    expect(await gate(h, 'staging', 's-2', SHA_A)).toMatchObject({ eligible: true });
  });
});
