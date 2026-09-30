import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '@qa/fixture-test-app';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, ROOT, type Harness } from './helpers.ts';

/**
 * Re-audit R1 on the real service: PostgreSQL, real worker processes killed
 * with SIGKILL (browser included) at the acknowledgement/confirmation
 * boundary and during an unkeyed deletion, restarted twice. An uncertain
 * effect is never replayed blindly, and no gate or promotion goes through
 * while it is unresolved — however many fresh results pass around it.
 */

const SHA = 'c'.repeat(40);
const EVIDENCE = join(ROOT, '.qa-work', 'evidence');
const open: Array<{ close(): Promise<void> }> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.pid) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
  while (open.length) await open.pop()!.close();
});

async function setup(scenarios: string[], retries = 0): Promise<Harness> {
  const config = projectConfig({ suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios, shards: 1, concurrency: 1, retries, signed_out_path: '/login' } });
  const h = await harness({ config, outDir: await mkdtemp(join(tmpdir(), 'qa-obl-')) });
  open.push(h);
  return h;
}

async function app(): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: SHA });
  open.push(a);
  return a;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 90_000, context = () => ''): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${context()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const api = (h: Harness, token: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  h.api.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });

async function deploy(h: Harness, a: FixtureApp, id: string): Promise<string> {
  const r = await api(h, h.tokens.ci!, 'POST', '/v1/deployment-events', { schema_version: 1, provider: 'pipeline', deployment_id: id, environment: 'staging', commit_sha: SHA, candidate_url: a.url, ci_run_id: 1 });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}

/** A real worker process in its own process group, killed as a whole (browser included). */
function workerProcess(h: Harness, out: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests/service/crash-worker.ts')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...h.env, DATABASE_URL: DATABASE_URL!, QA_SCHEMA: h.schema, QA_ROOT: ROOT, QA_OUT: out, QA_LEASE_SECONDS: '5' },
  });
  children.push(child);
  let log = '';
  child.stdout!.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (log += d.toString()));
  return {
    log: () => log,
    kill: async () => {
      process.kill(-child.pid!, 'SIGKILL');
      await until('worker exit', async () => child.exitCode !== null || child.signalCode !== null);
    },
  };
}

async function expireShardLease(h: Harness, run: string) {
  await h.db.query(`update jobs set lease_expires_at = now() - interval '1 second', max_attempts = 5 where run_id=$1 and kind='execute_shard' and state='leased'`, [run]);
}

const intentState = async (h: Harness, id: string) => (await h.db.one<{ state: string }>('select state from action_intents where intent_id=$1', [id]))?.state;
const transitionsOf = async (h: Harness, id: string) => (await h.db.query<{ from_state: string | null; to_state: string; fence: string }>('select from_state, to_state, fence::text from intent_transitions where intent_id=$1 order by id', [id])).rows;

describe.skipIf(!DATABASE_URL)('effect obligations (re-audit R1)', () => {
  it('a crash after acknowledgement, and another during recovery, end in a looked-up effect: never replayed, never duplicated', async () => {
    const h = await setup(['checkout_existing_customer']);
    const a = await app();
    const run = await deploy(h, a, 'ack-1');
    await h.worker.processOne(); // readiness → execute_shard queued
    const out = await mkdtemp(join(tmpdir(), 'qa-obl-ack-'));

    // 1. Hold the worker between the application's acknowledgement and effect confirmation, then kill it there.
    a.control.effectsDelayMs = 6_000;
    const w1 = workerProcess(h, out);
    const acked = await until(
      'checkout acknowledged, awaiting confirmation',
      async () => (await h.db.one<{ intent_id: string; idempotency_key: string }>(`select intent_id, idempotency_key from action_intents where run_id=$1 and contract_intent='checkout.submit' and state='ACKNOWLEDGED'`, [run])) ?? null,
      90_000,
      w1.log,
    );
    await w1.kill();
    expect(await intentState(h, acked.intent_id)).toBe('ACKNOWLEDGED');

    // 2. The replacement dies too — while it is still looking the effect up.
    await expireShardLease(h, run);
    const w2 = workerProcess(h, out);
    await until('recovery reconciling the acknowledged checkout', async () => (await intentState(h, acked.intent_id)) === 'RECONCILING', 60_000, w2.log);
    await w2.kill();
    expect(await intentState(h, acked.intent_id)).toBe('RECONCILING');
    expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(1);

    // 3. A third worker completes the recovery by lookup, then runs the case on a fresh fixture.
    a.control.effectsDelayMs = 0;
    await expireShardLease(h, run);
    await h.worker.drain();

    const transitions = await transitionsOf(h, acked.intent_id);
    expect(transitions.map((t) => t.to_state)).toEqual(['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'RECONCILING', 'RECONCILED']);
    expect(new Set(transitions.map((t) => t.fence)).size).toBe(3);
    expect((await h.db.one<{ detail: string }>('select detail from action_intents where intent_id=$1', [acked.intent_id]))!.detail).toMatch(/effect confirmed: order ord_/);
    expect([...a.store.orders.values()].filter((o) => o.idempotency_key === acked.idempotency_key)).toHaveLength(1);
    expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(2);
    const r = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}`)).json();
    expect(r.run.state).toBe('COMPLETED');
    expect(r.run.gate).toEqual({ eligible: true, reasons: [] });
    const open = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}/obligations`)).json();
    expect(open.obligations).toEqual([]);
  });

  it('an unkeyed deletion killed in flight holds the gate across two restarts and a passing sibling case, until adjudicated and retried', async () => {
    const h = await setup(['sign_in', 'notes_crud']);
    const a = await app();
    const run = await deploy(h, a, 'del-1');
    await h.worker.processOne();
    const out = await mkdtemp(join(tmpdir(), 'qa-obl-del-'));
    const deletes = () => a.store.writes.filter((w) => /^\/notes\/[\w-]+\/delete$/.test(w.path)).length;
    const creates = () => a.store.writes.filter((w) => w.path === '/notes').length;

    // 1. Kill the worker while its unkeyed deletion is being processed by the application.
    a.control.noteDeleteDelayMs = 4_000;
    const w1 = workerProcess(h, out);
    await until('note deletion in flight', async () => deletes() === 1, 120_000, w1.log);
    const del = (await h.db.one<{ intent_id: string; state: string }>(`select intent_id, state from action_intents where run_id=$1 and contract_intent='notes.delete'`, [run]))!;
    await w1.kill();
    expect(del.state).toBe('DISPATCHING');

    // 2. The replacement reconciles it to review, refuses to replay it — and is killed as well.
    await expireShardLease(h, run);
    const w2 = workerProcess(h, out);
    await until('replay refused', async () => /not replaying notes_crud@chromium_desktop/.test(w2.log()), 60_000, w2.log);
    await w2.kill();
    expect(await intentState(h, del.intent_id)).toBe('NEEDS_REVIEW');

    // 3. The third worker surfaces the same review again, runs only the unaffected case, and the run completes held.
    await expireShardLease(h, run);
    await h.worker.drain();
    const transitions = await transitionsOf(h, del.intent_id);
    expect(transitions.map((t) => t.to_state)).toEqual(['PREPARED', 'DISPATCHING', 'RECONCILING', 'NEEDS_REVIEW']);
    expect(deletes()).toBe(1);
    expect(creates()).toBe(1);
    const held = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}`)).json();
    const verdicts = Object.fromEntries(held.cases.filter((c: { attempt: number }) => c.attempt === 1).map((c: { scenario_id: string; verdict: string }) => [c.scenario_id, c.verdict]));
    expect(verdicts).toEqual({ sign_in: 'PASS', notes_crud: 'NEEDS_REVIEW' });
    expect(held.run.state).toBe('COMPLETED');
    expect(held.run.gate.eligible).toBe(false);
    expect(held.run.gate.reasons.join('\n')).toContain(`effect obligation ${del.intent_id}`);

    // Promotion is held by the obligation itself, independent of any stored verdict.
    const q = { project_id: 'shop', environment: 'staging', deployment_id: 'del-1', commit_sha: SHA };
    const gate = (await api(h, h.tokens.viewer!, 'GET', `/v1/gate?${new URLSearchParams(q)}`)).json();
    expect(gate.eligible).toBe(false);
    expect(gate.reasons).toContain(`effect obligation ${del.intent_id} (notes.delete in notes_crud@chromium_desktop, run ${run} attempt 1) is NEEDS_REVIEW with no adjudication`);
    const decision = (await api(h, h.tokens.ci!, 'POST', '/v1/promotions', q)).json();
    expect(decision.eligible).toBe(false);
    expect((await api(h, h.tokens.ci!, 'POST', `/v1/promotions/${decision.decision_id}/consume`, {})).json().promoted).toBe(false);

    // The dead worker's acknowledged-but-unsettled note creation is an obligation too: nothing confirmed it.
    const obligations = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}/obligations`)).json().obligations as Array<{ intent_id: string; contract_intent: string; state: string }>;
    expect(obligations.map((o) => [o.contract_intent, o.state])).toEqual([
      ['notes.create', 'NEEDS_REVIEW'],
      ['notes.delete', 'NEEDS_REVIEW'],
    ]);
    const create = obligations[0]!.intent_id;
    expect((await transitionsOf(h, create)).map((t) => t.to_state)).toEqual(['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'RECONCILING', 'NEEDS_REVIEW']);

    // Only an authorized, attributed adjudication resolves an obligation; the held case still needs a rerun.
    const adjudicate = (token: string, id = del.intent_id) => api(h, token, 'POST', `/v1/intents/${id}/adjudicate`, { resolution: 'effect_present_accepted', note: 'test-owned note in the dead worker fixture; fixture swept' });
    expect((await adjudicate(h.tokens.ci!)).statusCode).toBe(403);
    expect((await adjudicate(h.tokens.viewer!)).statusCode).toBe(403);
    const ok = await adjudicate(h.tokens.admin!);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await adjudicate(h.tokens.admin!)).statusCode).toBe(409);
    const partial = (await api(h, h.tokens.viewer!, 'GET', `/v1/gate?${new URLSearchParams(q)}`)).json();
    expect(partial.reasons.filter((r: string) => r.startsWith('effect obligation'))).toEqual([expect.stringContaining(create)]);
    expect((await adjudicate(h.tokens.admin!, create)).statusCode).toBe(200);
    const afterAdjudication = (await api(h, h.tokens.viewer!, 'GET', `/v1/gate?${new URLSearchParams(q)}`)).json();
    expect(afterAdjudication.eligible).toBe(false);
    expect(afterAdjudication.reasons.join('\n')).not.toContain('effect obligation');

    a.control.noteDeleteDelayMs = 0;
    expect((await api(h, h.tokens.ci!, 'POST', `/v1/runs/${run}/retry`, { reason: 'obligation adjudicated' })).statusCode).toBe(200);
    await h.worker.drain();
    const retried = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}`)).json();
    expect(retried.run.gate).toEqual({ eligible: true, reasons: [] });
    expect(deletes()).toBe(2);
    const promoted = (await api(h, h.tokens.ci!, 'POST', '/v1/promotions', q)).json();
    expect(promoted.eligible).toBe(true);
    expect((await api(h, h.tokens.ci!, 'POST', `/v1/promotions/${promoted.decision_id}/consume`, {})).json().promoted).toBe(true);
    const audit = (await h.db.query<{ action: string; actor: string }>(`select action, actor from audit_log where action='intent.adjudicate'`)).rows;
    expect(audit).toHaveLength(2);

    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(join(EVIDENCE, 'obligation-hold.json'), JSON.stringify({ run_id: run, intent: del.intent_id, transitions, obligations_while_held: obligations, delete_requests_before_retry: 1, held_gate: held.run.gate, gate_while_open: gate, adjudication: ok.json(), gate_after_retry: retried.run.gate }, null, 2));
  });

  it('an advisory-shard effect still in flight holds the live gate even after the required cases pass', async () => {
    const h = await setup(['sign_in']);
    const a = await app();
    const run = await deploy(h, a, 'live-1');
    await h.worker.drain();
    const r = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}`)).json();
    expect(r.run.gate).toEqual({ eligible: true, reasons: [] });
    // An exploration job still holding its lease with a checkout dispatched.
    const job = (await h.db.one<{ id: string }>(`insert into jobs(tenant_id, run_id, kind, payload, state, lease_owner, lease_expires_at, fence) values ('acme',$1,'execute_shard','{"attempt":1,"shard":9,"advisory":true,"cases":[]}','leased','explorer', now() + interval '5 minutes', 1) returning id::text`, [run]))!;
    await h.db.query(
      `insert into action_intents(intent_id, tenant_id, run_id, run_attempt, shard, job_id, fence, attempt_id, scenario_id, execution_profile, owner, idempotency_key, effect, mutation, contract_intent, state, data)
       values ('x.i1','acme',$1,1,9,$2,1,'x','checkout_existing_customer','chromium_desktop','u_x','x.i1','mutation','test_owned_order_create','checkout.submit','DISPATCHING','{}')`,
      [run, job.id],
    );
    const q = new URLSearchParams({ project_id: 'shop', environment: 'staging', deployment_id: 'live-1', commit_sha: SHA });
    const gate = (await api(h, h.tokens.viewer!, 'GET', `/v1/gate?${q}`)).json();
    expect(gate.eligible).toBe(false);
    expect(gate.reasons).toContain(`effect obligation x.i1 (checkout.submit in checkout_existing_customer@chromium_desktop, run ${run} attempt 1) is DISPATCHING and still in progress`);
  });

  it('review-3 N2: inside one service shard, a retry never replays a checkout whose effect could not be looked up, and the gate holds', async () => {
    const h = await setup(['checkout_existing_customer'], 2);
    const a = await app();
    a.control.effectsDelayMs = 11_000; // longer than the adapter's 10 s lookup timeout: the effect cannot be established
    const run = await deploy(h, a, 'svc-retry-1');
    await h.worker.drain();
    const r = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}`)).json();
    expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(1);
    expect(r.cases.map((c: { verdict: string; result: { reason: string } }) => [c.verdict, c.result.reason])).toEqual([['NEEDS_REVIEW', 'effect_unreconciled']]);
    expect(r.run.gate.eligible).toBe(false);
    const open = (await api(h, h.tokens.viewer!, 'GET', `/v1/runs/${run}/obligations`)).json().obligations as Array<{ contract_intent: string; state: string }>;
    expect(open.map((o) => [o.contract_intent, o.state])).toEqual([['checkout.submit', 'NEEDS_REVIEW']]);
  }, 120_000);
});
