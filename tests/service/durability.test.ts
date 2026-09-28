import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '@qa/fixture-test-app';
import { JobWorker, PgIntentStore, Sweeper } from '@qa/orchestrator';
import { FenceLost } from '@qa/worker';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, ROOT, type Harness } from './helpers.ts';

/**
 * Durable intents, reconciliation, lease fencing and atomic tenant admission
 * (audit F09 and the concurrency risk). The crash test kills a real worker
 * process group — browser included — while its checkout is in flight.
 */

const SHA = 'a'.repeat(40);
const open: Array<{ close(): Promise<void> }> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.pid) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
  while (open.length) await open.pop()!.close();
});

const EVIDENCE = join(ROOT, '.qa-work', 'evidence');

function suite(scenarios: string[]) {
  return projectConfig({ suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios, shards: 1, concurrency: 1, signed_out_path: '/login' } });
}

async function setup(scenarios: string[]): Promise<Harness> {
  const h = await harness({ config: suite(scenarios), outDir: await mkdtemp(join(tmpdir(), 'qa-dur-')) });
  open.push(h);
  return h;
}

async function app(checkoutDelayMs = 0): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: SHA, checkoutDelayMs });
  open.push(a);
  return a;
}

async function deploy(h: Harness, a: FixtureApp, id: string): Promise<string> {
  const r = await h.api.inject({ method: 'POST', url: '/v1/deployment-events', headers: { authorization: `Bearer ${h.tokens.ci}`, 'content-type': 'application/json' }, payload: JSON.stringify({ schema_version: 1, provider: 'pipeline', deployment_id: id, environment: 'staging', commit_sha: SHA, candidate_url: a.url, ci_run_id: 1 }) });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!DATABASE_URL)('durable execution (completion phase 2)', () => {
  it('admits at most max_concurrent_jobs leases per tenant under concurrent workers', async () => {
    const h = await setup(['sign_in']);
    await h.db.query(`update tenants set max_concurrent_jobs=2 where id='acme'`);
    await h.db.query(`insert into jobs(tenant_id, kind) select 'acme', 'noop' from generate_series(1, 30)`);
    const workers = Array.from({ length: 12 }, (_, i) => new JobWorker(h.orch, { outDir: tmpdir(), workerId: `w${i}`, leaseSeconds: 60 }));
    const leased = (await Promise.all(workers.map((w) => w.lease()))).filter(Boolean);
    const second = (await Promise.all(workers.map((w) => w.lease()))).filter(Boolean);
    const active = (await h.db.one<{ n: number }>(`select count(*)::int n from jobs where tenant_id='acme' and state='leased' and lease_expires_at >= now()`))!.n;
    expect(active).toBe(2);
    expect(leased.length + second.length).toBe(2);
    // Every lease carries a fresh fence.
    expect(leased.concat(second).every((j) => j!.fence === 1)).toBe(true);
  });

  it('fences a worker that lost its lease: no intent can be recorded, so nothing can be dispatched', async () => {
    const h = await setup(['checkout_existing_customer']);
    const a = await app();
    const run = await deploy(h, a, 'fence-1');
    await h.worker.processOne(); // readiness → execute_shard queued
    const stale = new JobWorker(h.orch, { outDir: tmpdir(), workerId: 'stale', leaseSeconds: 60 });
    const jobA = (await stale.lease())!;
    expect(jobA.kind).toBe('execute_shard');
    await h.db.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [jobA.id]);
    const fresh = new JobWorker(h.orch, { outDir: tmpdir(), workerId: 'fresh', leaseSeconds: 60 });
    const jobB = (await fresh.lease())!;
    expect(jobB.id).toBe(jobA.id);
    expect(jobB.fence).toBe(jobA.fence + 1);

    const scope = { tenant_id: 'acme', run_id: run, run_attempt: 1, shard: 0, job_id: jobA.id };
    const intent = { attempt_id: 'x', scenario_id: 'checkout_existing_customer', execution_profile: 'chromium_desktop', owner: 'u_1', idempotency_key: null, effect: 'none', mutation: null, contract_intent: null, data: {} };
    await expect(new PgIntentStore(h.db, { ...scope, fence: jobA.fence }).prepare({ ...intent, intent_id: 'stale.i1' })).rejects.toBeInstanceOf(FenceLost);
    await new PgIntentStore(h.db, { ...scope, fence: jobB.fence }).prepare({ ...intent, intent_id: 'fresh.i1' });
    expect((await h.db.query(`select intent_id from action_intents where run_id=$1`, [run])).rows).toEqual([{ intent_id: 'fresh.i1' }]);
    // The stale worker's completion is rejected as well.
    const done = await h.db.query(`update jobs set state='done' where id=$1 and fence=$2 and state='leased'`, [jobA.id, jobA.fence]);
    expect(done.rowCount).toBe(0);
  });

  it('a worker killed mid-checkout is recovered by reconciliation: the effect is confirmed, never duplicated, and the run completes', async () => {
    const h = await setup(['checkout_existing_customer']);
    const a = await app(3_000);
    const run = await deploy(h, a, 'crash-1');
    await h.worker.processOne(); // readiness → execute_shard queued

    const out = await mkdtemp(join(tmpdir(), 'qa-crash-'));
    const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests/service/crash-worker.ts')], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...h.env, DATABASE_URL: DATABASE_URL!, QA_SCHEMA: h.schema, QA_ROOT: ROOT, QA_OUT: out, QA_LEASE_SECONDS: '5' },
    });
    children.push(child);
    let childLog = '';
    child.stdout!.on('data', (d: Buffer) => (childLog += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (childLog += d.toString()));

    // Kill the whole worker process group once its checkout request has reached the application.
    await until('checkout request in flight', async () => a.store.writes.some((w) => w.path === '/checkout'), 90_000).catch((e: Error) => {
      throw new Error(`${e.message}\n${childLog}`);
    });
    const before = (await h.db.query<{ intent_id: string; state: string; idempotency_key: string }>(`select intent_id, state, idempotency_key from action_intents where run_id=$1 and contract_intent='checkout.submit'`, [run])).rows;
    process.kill(-child.pid!, 'SIGKILL');
    await until('worker exit', async () => child.exitCode !== null || child.signalCode !== null);
    expect(before).toHaveLength(1);
    expect(before[0]!.state).toBe('DISPATCHING');
    const crashed = before[0]!;

    // The application finishes the order the dead worker submitted.
    await until('order committed', async () => [...a.store.orders.values()].some((o) => o.idempotency_key === crashed.idempotency_key), 10_000);
    const firstOwner = [...a.store.orders.values()].find((o) => o.idempotency_key === crashed.idempotency_key)!.customer_id;

    // Lease expires; a healthy worker takes over under a new fence.
    await h.db.query(`update jobs set lease_expires_at = now() - interval '1 second' where run_id=$1 and kind='execute_shard'`, [run]);
    await h.worker.drain();

    const rec = (await h.db.one<{ state: string; detail: string; fence: string }>(`select state, detail, fence::text from action_intents where intent_id=$1`, [crashed.intent_id]))!;
    const transitions = (await h.db.query<{ from_state: string | null; to_state: string; fence: string }>(`select from_state, to_state, fence::text from intent_transitions where intent_id=$1 order by id`, [crashed.intent_id])).rows;
    const receipts = (await h.db.query<{ entity_id: string; owner: string }>(`select entity_id, owner from effect_receipts where intent_id=$1`, [crashed.intent_id])).rows;
    const r = (await h.api.inject({ method: 'GET', url: `/v1/runs/${run}`, headers: { authorization: `Bearer ${h.tokens.viewer}` } })).json();

    expect(rec.state).toBe('RECONCILED');
    expect(rec.detail).toMatch(/effect confirmed: order ord_/);
    expect(transitions.map((t) => t.to_state)).toEqual(['PREPARED', 'DISPATCHING', 'RECONCILING', 'RECONCILED']);
    expect(new Set(transitions.map((t) => t.fence)).size).toBe(2);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.owner).toBe(firstOwner);
    // Exactly one order for the dead worker's intent; the recovered run used a fresh fixture.
    expect([...a.store.orders.values()].filter((o) => o.idempotency_key === crashed.idempotency_key)).toHaveLength(1);
    expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(2);
    expect(r.run.state).toBe('COMPLETED');
    expect(r.run.gate).toEqual({ eligible: true, reasons: [] });

    // The dead worker's fixture is swept by its durable cleanup obligation.
    const swept = await new Sweeper(h.orch, { env: h.env }).cleanup();
    expect(swept.cleaned).toBe(1);
    expect(a.store.users.size).toBe(0);

    await mkdir(EVIDENCE, { recursive: true });
    await writeFile(
      join(EVIDENCE, 'crash-recovery.json'),
      JSON.stringify({ run_id: run, crashed_intent: crashed, intent_after_recovery: rec, transitions, receipts, orders_for_intent: 1, checkout_requests: 2, run_state: r.run.state, gate: r.run.gate, swept: swept.cleaned, child_log_tail: childLog.split('\n').slice(-10) }, null, 2),
    );
  });
});

describe.skipIf(!DATABASE_URL)('operations (completion phase 10)', () => {
  it('startup checks pass on a configured service and fail closed on a missing fixture token', async () => {
    const { checkStartup } = await import('@qa/orchestrator');
    const h = await setup(['sign_in']);
    const ok = await checkStartup(h.db, h.orch, { role: 'worker', env: h.env, launchBrowser: async () => ({ close: async () => undefined }) });
    expect(ok.filter((c) => !c.ok), JSON.stringify(ok)).toEqual([]);
    expect(ok.map((c) => c.name)).toEqual(expect.arrayContaining(['database', 'migrations', 'project:shop:suite', 'project:shop:fixture_token', 'browser']));
    const { QA_FIXTURE_TOKEN_SHOP: _drop, ...noToken } = h.env;
    const bad = await checkStartup(h.db, h.orch, { role: 'worker', env: { ...noToken, QA_AUTONOMY_MODE: 'yolo', QA_S1_PROVIDER: 'typesafe' }, launchBrowser: async () => Promise.reject(new Error('no chromium')) });
    expect(bad.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual(['autonomy_mode', 'browser', 'project:shop:fixture_token', 's1_probe']);
  });

  it('exposes metrics only to the configured scrape token', async () => {
    const h = await harness({ config: suite(['sign_in']), outDir: await mkdtemp(join(tmpdir(), 'qa-met-')), api: { env: { ...process.env, QA_METRICS_TOKEN: 'metrics-token-0123456789' } } });
    open.push(h);
    await h.db.query(`insert into jobs(tenant_id, kind, state, lease_owner, lease_expires_at) values ('acme','noop','leased','dead', now() - interval '1 minute')`);
    expect((await h.api.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const r = await h.api.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-0123456789' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/^qa_jobs_expired_leases 1$/m);
    expect(r.body).toMatch(/# TYPE qa_intents gauge/);
    const off = await setup(['sign_in']);
    expect((await off.api.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-0123456789' } })).statusCode).toBe(404);
  });
});
