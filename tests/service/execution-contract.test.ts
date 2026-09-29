import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '@qa/fixture-test-app';
import { FsBaselineStore } from '@qa/quality';
import { DATABASE_URL, FIXTURE_TOKEN, harness, projectConfig, type Harness } from './helpers.ts';

/**
 * Re-audit R2: a result qualifies only under the complete execution contract
 * it was produced under. Each verdict-relevant setting is changed on its own
 * after a passing run; the old run and any decision relying on it stop
 * qualifying, and only a new execution regains eligibility. Changes made
 * while a run is in progress are caught before execution and at aggregation.
 */

const SHA = 'e'.repeat(40);
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const base = () => projectConfig({ suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'], scenarios: ['sign_in'], shards: 1, concurrency: 1, signed_out_path: '/login' } });
type Config = ReturnType<typeof base>;

async function setup(baselines?: FsBaselineStore): Promise<Harness> {
  const h = await harness({ config: base(), outDir: await mkdtemp(join(tmpdir(), 'qa-exec-')), ...(baselines ? { deps: { baselinesFor: () => baselines } } : {}) });
  open.push(h);
  return h;
}

async function app(): Promise<FixtureApp> {
  const a = await startFixtureApp({ fixtureToken: FIXTURE_TOKEN, commitSha: SHA });
  open.push(a);
  return a;
}

const call = (h: Harness, token: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  h.api.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });

async function deploy(h: Harness, a: FixtureApp, id: string): Promise<string> {
  const r = await call(h, h.tokens.ci!, 'POST', '/v1/deployment-events', { schema_version: 1, provider: 'pipeline', deployment_id: id, environment: 'staging', commit_sha: SHA, candidate_url: a.url, ci_run_id: 1 });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run_id as string;
}

const setConfig = (h: Harness, cfg: Config) => h.db.query(`update projects set config=$1 where id='shop'`, [JSON.stringify(cfg)]);
const gate = async (h: Harness, id: string) => (await call(h, h.tokens.viewer!, 'GET', `/v1/gate?${new URLSearchParams({ project_id: 'shop', environment: 'staging', deployment_id: id, commit_sha: SHA })}`)).json() as { eligible: boolean; reasons: string[] };

describe.skipIf(!DATABASE_URL)('execution contract (re-audit R2)', () => {
  it('each verdict-relevant setting, changed alone, stops an earlier passing run and its decision from qualifying', async () => {
    const h = await setup();
    const a = await app();
    const other = await app();
    const run = await deploy(h, a, 'x-1');
    await h.worker.drain();
    expect(await gate(h, 'x-1')).toEqual({ eligible: true, run_id: run, reasons: [] });
    const decision = (await call(h, h.tokens.ci!, 'POST', '/v1/promotions', { project_id: 'shop', environment: 'staging', deployment_id: 'x-1', commit_sha: SHA })).json();
    expect(decision.eligible).toBe(true);

    const changes: Array<[string, (c: Config) => void, RegExp]> = [
      ['oracle backend endpoint (the reproduction in the re-audit)', (c) => void (c.fixture_api = { ...c.fixture_api, url: other.url } as never), /oracle: endpoint/],
      ['oracle credential reference', (c) => void (c.fixture_api = { ...c.fixture_api, token_env: 'QA_OTHER_FIXTURE_TOKEN' }), /oracle: token_ref_sha256/],
      ['environment policy', (c) => void (c.environments.staging = { ...c.environments.staging, url_patterns: ['http://127.0.0.1:*', 'https://*.example.test'] }), /environment: policy/],
      ['version verification', (c) => void (c.version_check = { ...c.version_check, field: 'sha' }), /verification: version_check/],
      ['retries', (c) => void ((c.suite as { retries?: number }).retries = 2), /suite: retries/],
      ['required profiles', (c) => void c.suite.profiles.push('chromium_mobile_viewport'), /suite: .*required_profiles/],
    ];
    const seen: Record<string, string[]> = {};
    for (const [what, mutate, expected] of changes) {
      const cfg = base();
      mutate(cfg);
      await setConfig(h, cfg);
      const g = await gate(h, 'x-1');
      seen[what] = g.reasons;
      expect(g.eligible, what).toBe(false);
      expect(g.reasons.join('\n'), what).toMatch(expected);
      await setConfig(h, base());
      expect((await gate(h, 'x-1')).eligible, `${what} restored`).toBe(true);
    }

    // A decision taken before the change cannot be consumed after it.
    const cfg = base();
    (cfg.fixture_api as { url?: string }).url = other.url;
    await setConfig(h, cfg);
    const consumed = (await call(h, h.tokens.ci!, 'POST', `/v1/promotions/${decision.decision_id}/consume`, {})).json();
    expect(consumed.promoted).toBe(false);
    expect(consumed.reasons.join('\n')).toMatch(/oracle: endpoint/);

    // A new execution under the new contract regains eligibility (the same backend, named explicitly).
    (cfg.fixture_api as { url?: string }).url = a.url;
    await setConfig(h, cfg);
    expect((await gate(h, 'x-1')).eligible).toBe(false);
    expect((await call(h, h.tokens.ci!, 'POST', `/v1/runs/${run}/retry`, { reason: 'oracle endpoint changed' })).statusCode).toBe(200);
    await h.worker.drain();
    expect(await gate(h, 'x-1')).toEqual({ eligible: true, run_id: run, reasons: [] });
    const snap = (await h.db.one<{ execution_snapshot: { oracle: { endpoint: string; token_ref_sha256: string } } }>('select execution_snapshot from runs where id=$1', [run]))!.execution_snapshot;
    expect(snap.oracle.endpoint).toBe(new URL(a.url).href);
    expect(snap.oracle.token_ref_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(snap)).not.toContain(FIXTURE_TOKEN);
  });

  it('a change made while the run is in progress is refused before execution and caught at aggregation', async () => {
    const h = await setup();
    const a = await app();
    // Before execution: the shard refuses to run under a contract other than the one selected.
    const r1 = await deploy(h, a, 'p-1');
    await h.worker.processOne(); // readiness → shard queued
    const cfg = base();
    (cfg.fixture_api as { url?: string }).url = a.url;
    await setConfig(h, cfg);
    await h.worker.drain();
    const run1 = (await call(h, h.tokens.viewer!, 'GET', `/v1/runs/${r1}`)).json();
    expect(run1.cases).toEqual([]);
    expect(run1.run.state).not.toBe('COMPLETED');
    expect((await gate(h, 'p-1')).eligible).toBe(false);

    // After execution, before aggregation: the results are stale and the stored gate is held.
    await setConfig(h, base());
    const r2 = await deploy(h, a, 'p-2');
    await h.worker.processOne(); // readiness
    await h.worker.processOne(); // shard executes
    await setConfig(h, cfg);
    await h.worker.drain(); // aggregation
    const run2 = (await call(h, h.tokens.viewer!, 'GET', `/v1/runs/${r2}`)).json();
    expect(run2.cases.map((c: { verdict: string }) => c.verdict)).toEqual(['PASS']);
    expect(run2.run.gate.eligible).toBe(false);
    expect(run2.run.gate.reasons.join('\n')).toMatch(/execution contract .*oracle: endpoint/);
  });

  it('baselines are frozen at submission: a later approval makes the old run stale and is used only by a new execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-exec-bl-'));
    const store = new FsBaselineStore(dir);
    const h = await setup(store);
    const a = await app();
    const run = await deploy(h, a, 'b-1');
    await h.worker.drain();
    const frozen = (await h.db.one<{ execution_snapshot: { baselines: unknown[] } }>('select execution_snapshot from runs where id=$1', [run]))!.execution_snapshot.baselines;
    expect(frozen).toEqual([]);
    expect((await gate(h, 'b-1')).eligible).toBe(true);

    const buf = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    await store.approve({ scenario_id: 'sign_in', checkpoint: 'x', execution_profile: 'chromium_desktop', rendering_profile: 'r' }, buf, { approved_by: 'token:reviewer', commit_sha: SHA, source: 'test', expected_sha256: createHash('sha256').update(buf).digest('hex'), expected_version: 0 });
    const g = await gate(h, 'b-1');
    expect(g.eligible).toBe(false);
    expect(g.reasons.join('\n')).toMatch(/baselines/);
    expect((await call(h, h.tokens.ci!, 'POST', `/v1/runs/${run}/retry`, { reason: 'baseline approved' })).statusCode).toBe(200);
    await h.worker.drain();
    expect((await gate(h, 'b-1')).eligible).toBe(true);
    const refrozen = (await h.db.one<{ execution_snapshot: { baselines: Array<{ version: number }> } }>('select execution_snapshot from runs where id=$1', [run]))!.execution_snapshot.baselines;
    expect(refrozen.map((b) => b.version)).toEqual([1]);
  });
});
