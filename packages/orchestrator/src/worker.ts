import { hostname } from 'node:os';
import type pg from 'pg';
import { evaluateReleaseGate, type CaseResult, type ExecutionProfileId } from '@qa/contracts';
import { FixtureClient } from '@qa/oracles';
import { runSuite, type ExplorationOptions } from '@qa/worker';
import { basename } from 'node:path';
import { uploadDir } from '@qa/evidence';
import { FindingLedger } from '@qa/quality';
import { checkReadiness, readRevision } from './readiness.ts';
import { Sweeper } from './sweepers.ts';
import { newId, type Orchestrator } from './service.ts';
import { loadSuite, shard } from './suite.ts';
import type { ProjectRow, RunRow } from './types.ts';

export interface Job {
  id: string;
  tenant_id: string;
  run_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface WorkerOptions {
  outDir: string;
  workerId?: string;
  leaseSeconds?: number;
  /** How often an executing shard checks for cancellation or supersession. */
  cancelPollMs?: number;
  exploration?: ExplorationOptions;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Run cleanup and retention sweeps this often in `run()` (default 5 minutes). */
  sweepIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED'];

/**
 * Durable job processor. Jobs are leased with renewable leases, fairly across
 * tenants and within each tenant's concurrency quota; an expired lease is
 * re-leased, and a job that exhausts its attempts fails its run visibly.
 */
export class JobWorker {
  readonly id: string;
  private stopped = false;

  constructor(
    private readonly orch: Orchestrator,
    private readonly o: WorkerOptions,
  ) {
    this.id = o.workerId ?? `${hostname()}:${process.pid}:${newId('w')}`;
  }

  private get db() {
    return this.orch.db;
  }

  private log(msg: string) {
    this.o.log?.(`[${this.id}] ${msg}`);
  }

  async lease(): Promise<Job | null> {
    const lease = this.o.leaseSeconds ?? 60;
    const r = await this.db.query<Job>(
      `with active as (
         select tenant_id, count(*) n from jobs where state='leased' and lease_expires_at >= now() group by tenant_id
       ), candidate as (
         select j.id from jobs j join tenants t on t.id = j.tenant_id left join active a on a.tenant_id = j.tenant_id
         where ((j.state='queued' and j.available_at <= now()) or (j.state='leased' and j.lease_expires_at < now()))
           and coalesce(a.n, 0) < t.max_concurrent_jobs
         order by coalesce(a.n, 0), j.available_at, j.id
         limit 1 for update of j skip locked
       )
       update jobs set state='leased', lease_owner=$1, lease_expires_at=now() + make_interval(secs => $2), attempts=attempts+1, updated_at=now()
       from candidate where jobs.id = candidate.id
       returning jobs.id::text, jobs.tenant_id, jobs.run_id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts`,
      [this.id, lease],
    );
    return r.rows[0] ?? null;
  }

  /** Lease and process one job. Returns false when nothing was available. */
  async processOne(): Promise<boolean> {
    const job = await this.lease();
    if (!job) return false;
    if (job.attempts > job.max_attempts) {
      await this.failPermanently(job, 'lease expired too many times (worker loss?)');
      return true;
    }
    const lease = this.o.leaseSeconds ?? 60;
    const beat = setInterval(() => {
      void this.db.query(`update jobs set lease_expires_at=now() + make_interval(secs => $3) where id=$1 and lease_owner=$2 and state='leased'`, [job.id, this.id, lease]).catch(() => undefined);
    }, (lease * 1000) / 3);
    try {
      this.log(`${job.kind} ${job.run_id ?? ''} (attempt ${job.attempts})`);
      await this.handle(job);
      await this.db.query(`update jobs set state='done', updated_at=now() where id=$1 and lease_owner=$2 and state='leased'`, [job.id, this.id]);
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`${job.kind} failed: ${msg}`);
      if (job.attempts >= job.max_attempts) await this.failPermanently(job, msg);
      else {
        // Full jitter, capped: spreads retries after shared outages.
        const delay = Math.random() * Math.min(300, 2 ** job.attempts);
        await this.db.query(`update jobs set state='queued', lease_owner=null, lease_expires_at=null, last_error=$2, available_at=now() + make_interval(secs => $3), updated_at=now() where id=$1 and lease_owner=$4`, [job.id, msg, delay, this.id]);
      }
    } finally {
      clearInterval(beat);
    }
    return true;
  }

  private async failPermanently(job: Job, msg: string): Promise<void> {
    await this.db.tx(async (c) => {
      await c.query(`update jobs set state='failed', last_error=$2, updated_at=now() where id=$1`, [job.id, msg]);
      if (!job.run_id) return;
      if (job.kind === 'execute_shard') await this.settleShard(c, job.run_id, Number(job.payload.attempt));
      else await this.finishRun(c, job.run_id, 'ERROR', 'infrastructure_error', `${job.kind} failed permanently: ${msg}`);
    });
  }

  /** Process jobs and outbox events until both are empty (tests and one-shot CLI). */
  async drain(maxIterations = 10_000): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const didJob = await this.processOne();
      const didOutbox = (await this.publishOutbox()) > 0;
      if (!didJob && !didOutbox) return;
    }
    throw new Error('drain did not settle');
  }

  async run(pollMs = 1000): Promise<void> {
    const sweeper = new Sweeper(this.orch, { ...(this.o.env ? { env: this.o.env } : {}), alert: (m) => this.log(m) });
    let lastSweep = 0;
    while (!this.stopped) {
      if (Date.now() - lastSweep > (this.o.sweepIntervalMs ?? 300_000)) {
        lastSweep = Date.now();
        await sweeper.runOnce().catch((e: Error) => this.log(`sweep error: ${e.message}`));
      }
      const did = await this.processOne().catch((e: Error) => (this.log(`loop error: ${e.message}`), false));
      await this.publishOutbox().catch((e: Error) => this.log(`outbox error: ${e.message}`));
      if (!did) await sleep(pollMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  // ---------- handlers ----------

  private async handle(job: Job): Promise<void> {
    switch (job.kind) {
      case 'readiness':
        return this.readiness(job);
      case 'execute_shard':
        return this.executeShard(job);
      case 'aggregate':
        return this.aggregate(job);
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
  }

  private async load(runId: string): Promise<{ run: RunRow; project: ProjectRow; url: string }> {
    const run = (await this.db.one<RunRow>('select * from runs where id=$1', [runId]))!;
    const project = (await this.orch.projectById(run.project_id))!;
    const dep = (await this.db.one<{ immutable_url: string }>('select immutable_url from deployments where id=$1', [run.deployment_id]))!;
    return { run, project, url: dep.immutable_url };
  }

  private stale(run: RunRow, job: Job): boolean {
    return TERMINAL.includes(run.state) || Number(job.payload.attempt) !== run.attempt;
  }

  private async readiness(job: Job): Promise<void> {
    const { run, project, url } = await this.load(job.run_id!);
    if (this.stale(run, job)) return;
    const cfg = project.config;
    const deadline = Date.now() + cfg.readiness.timeout_seconds * 1000;
    let last = await checkReadiness(url, cfg.version_check, run.commit_sha);
    while (!last.ready && Date.now() < deadline) {
      const now = await this.db.one<RunRow>('select * from runs where id=$1', [run.id]);
      if (!now || this.stale(now, job) || now.cancel_requested) break;
      await sleep(cfg.readiness.interval_seconds * 1000);
      last = await checkReadiness(url, cfg.version_check, run.commit_sha);
    }
    await this.db.tx(async (c) => {
      const cur = (await c.query<RunRow>('select * from runs where id=$1 for update', [run.id])).rows[0]!;
      if (this.stale(cur, job)) return;
      if (cur.cancel_requested) return this.finishRun(c, run.id, 'CANCELLED', 'cancelled', 'cancelled before execution');
      if (!last.ready) {
        const detail = last.checks.filter((x) => !x.ok).map((x) => `${x.check}: ${x.detail ?? ''}`).join('; ');
        return this.finishRun(c, run.id, 'ERROR', last.revision_mismatch ? 'version_drift' : 'not_ready', `target not ready: ${detail}`);
      }
      const cases = cur.selection_manifest?.cases ?? [];
      if (cases.length === 0) return this.finishRun(c, run.id, 'ERROR', 'no_assertions_executed', 'selection is empty; an empty suite cannot satisfy the gate');
      await c.query(`update runs set state='QUEUED', updated_at=now() where id=$1 and state='WAITING_READY'`, [run.id]);
      const shards = shard(cases, cfg.suite.shards);
      for (const [i, s] of shards.entries()) {
        await c.query('insert into jobs(tenant_id, run_id, kind, payload, max_attempts) values ($1,$2,$3,$4,2)', [run.tenant_id, run.id, 'execute_shard', JSON.stringify({ attempt: cur.attempt, shard: i, cases: s.map(({ scenario_id, execution_profile }) => ({ scenario_id, execution_profile })) })]);
      }
      if (this.o.exploration && (cur.selection_manifest?.exploration.length ?? 0) > 0) {
        await c.query('insert into jobs(tenant_id, run_id, kind, payload, max_attempts) values ($1,$2,$3,$4,1)', [run.tenant_id, run.id, 'execute_shard', JSON.stringify({ attempt: cur.attempt, shard: shards.length, advisory: true, cases: cur.selection_manifest!.exploration })]);
      }
      await this.orch.enqueueStatus(c, run.tenant_id, run.id);
    });
  }

  private async executeShard(job: Job): Promise<void> {
    const { run, project, url } = await this.load(job.run_id!);
    if (this.stale(run, job)) return;
    if (run.cancel_requested) {
      await this.db.tx(async (c) => {
        await c.query(`update jobs set state='cancelled', updated_at=now() where id=$1`, [job.id]);
        await this.settleShard(c, run.id, run.attempt);
      });
      return;
    }
    await this.db.query(`update runs set state='RUNNING', updated_at=now() where id=$1 and state='QUEUED'`, [run.id]);
    const cfg = project.config;
    const suite = await loadSuite(cfg, this.orch.deps.suiteBaseDir);
    if (suite.revision !== run.suite_revision) throw new Error(`suite changed since selection (${run.suite_revision} → ${suite.revision})`);
    const env = this.o.env ?? process.env;
    const readOnly = cfg.environments[run.environment]?.read_only === true;
    const token = env[cfg.fixture_api.token_env];
    if (!token && !readOnly) throw new Error(`fixture token variable ${cfg.fixture_api.token_env} is not set`);
    const fixtures = new FixtureClient(cfg.fixture_api.url ?? url, token ?? 'read-only-profile-has-no-fixture-access');
    const cases = job.payload.cases as Array<{ scenario_id: string; execution_profile: ExecutionProfileId }>;
    const advisory = job.payload.advisory === true;

    const ac = new AbortController();
    const poll = setInterval(() => {
      void this.db
        .one<{ state: string; cancel_requested: boolean; attempt: number }>('select state, cancel_requested, attempt from runs where id=$1', [run.id])
        .then((r) => {
          if (!r || r.cancel_requested || r.state === 'SUPERSEDED' || r.state === 'CANCELLED' || r.attempt !== run.attempt) ac.abort();
        })
        .catch(() => undefined);
    }, this.o.cancelPollMs ?? 1000);
    let results: CaseResult[];
    let runDirKey: string;
    const ledger = new FindingLedger();
    try {
      const { report, runDir } = await runSuite({
        quality: { baselines: this.orch.deps.baselinesFor?.(project) ?? null, findings: ledger, commitSha: run.commit_sha },
        scenarios: suite.scenarios.filter((s) => cases.some((c) => c.scenario_id === s.id)),
        policy: suite.policy,
        baseUrl: url,
        environment: run.environment,
        fixtures,
        outDir: this.o.outDir,
        runId: `${run.id}.a${run.attempt}.s${String(job.payload.shard)}`,
        commitSha: run.commit_sha,
        revision: () => readRevision(url, cfg.version_check),
        deploymentId: run.deployment_id,
        cases,
        retries: cfg.suite.retries,
        concurrency: cfg.suite.concurrency,
        signal: ac.signal,
        ...(readOnly ? { readOnly: true } : {}),
        ...(cfg.suite.signed_out_path ? { signedOutPath: cfg.suite.signed_out_path } : {}),
        ...(advisory && this.o.exploration ? { exploration: { ...this.o.exploration, s1: this.orch.deps.s1For?.(run.tenant_id, this.o.exploration.s1) ?? this.o.exploration.s1 } } : {}),
        hooks: {
          fixtureProvisioned: async (fixtureId) => {
            await this.db.query(`insert into cleanup_tasks(tenant_id, project_id, run_id, fixture_id, fixture_api_url) values ($1,$2,$3,$4,$5) on conflict (fixture_id) do nothing`, [run.tenant_id, project.id, run.id, fixtureId, cfg.fixture_api.url ?? url]);
          },
          cleanupSettled: async (fixtureId, ok, detail) => {
            await this.db.query(`update cleanup_tasks set state=$2, attempts=attempts+1, last_error=$3 where fixture_id=$1`, [fixtureId, ok ? 'done' : 'pending', ok ? null : detail]);
          },
        },
      });
      results = report.cases;
      const store = this.orch.deps.artifacts;
      if (store) {
        runDirKey = `${run.tenant_id}/${project.id}/${basename(runDir)}`;
        await uploadDir(store, runDir, runDirKey);
      } else runDirKey = runDir;
    } finally {
      clearInterval(poll);
    }

    await this.db.tx(async (c) => {
      const cur = (await c.query<RunRow>('select * from runs where id=$1 for update', [run.id])).rows[0]!;
      const owned = await c.query(`update jobs set state='done', updated_at=now() where id=$1 and lease_owner=$2 and state='leased'`, [job.id, this.id]);
      if (owned.rowCount === 0) throw new Error('lease lost; results discarded (another worker owns this shard)');
      if (cur.attempt === run.attempt) {
        for (const r of results) {
          await c.query(
            `insert into case_results(run_id, attempt, shard, scenario_id, execution_profile, verdict, result, run_dir) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
            [run.id, run.attempt, Number(job.payload.shard), r.scenario_id, r.execution_profile, r.verdict, JSON.stringify({ ...r, advisory }), runDirKey],
          );
        }
        for (const f of ledger.all()) {
          await c.query(
            `insert into findings(tenant_id, project_id, fingerprint, kind, scenario_id, checkpoint, execution_profile, requirement_ids, certainty, summary, occurrences, commits, evidence)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             on conflict (project_id, fingerprint) do update set occurrences = findings.occurrences + excluded.occurrences, last_seen = now(),
               commits = (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements(findings.commits || excluded.commits) x),
               evidence = (findings.evidence || excluded.evidence),
               certainty = case when findings.certainty = 'confirmed' or excluded.certainty = 'confirmed' then 'confirmed' when findings.certainty = 'reproduced' or excluded.certainty = 'reproduced' then 'reproduced' else 'suspected' end`,
            [run.tenant_id, project.id, f.fingerprint, f.kind, f.scenario_id, f.checkpoint, f.execution_profile, JSON.stringify(f.requirement_ids), f.certainty, f.summary, f.occurrences, JSON.stringify(f.commits), JSON.stringify(f.evidence.map((e) => ({ run_id: run.id, evidence: e })))],
          );
        }
      }
      await this.settleShard(c, run.id, run.attempt);
    });
  }

  /** When no shard of this attempt is still pending, schedule exactly one aggregation. */
  private async settleShard(c: pg.PoolClient, runId: string, attempt: number): Promise<void> {
    await c.query('select id from runs where id=$1 for update', [runId]);
    const pending = await c.query(`select 1 from jobs where run_id=$1 and kind='execute_shard' and (payload->>'attempt')::int=$2 and state in ('queued','leased') and not (state='leased' and lease_owner=$3)`, [runId, attempt, this.id]);
    if ((pending.rowCount ?? 0) > 0) return;
    const existing = await c.query(`select 1 from jobs where run_id=$1 and kind='aggregate' and (payload->>'attempt')::int=$2`, [runId, attempt]);
    if ((existing.rowCount ?? 0) > 0) return;
    const run = (await c.query<{ tenant_id: string }>('select tenant_id from runs where id=$1', [runId])).rows[0]!;
    await c.query('insert into jobs(tenant_id, run_id, kind, payload) values ($1,$2,$3,$4)', [run.tenant_id, runId, 'aggregate', JSON.stringify({ attempt })]);
  }

  private async aggregate(job: Job): Promise<void> {
    await this.db.tx(async (c) => {
      const run = (await c.query<RunRow>('select * from runs where id=$1 for update', [job.run_id])).rows[0]!;
      if (this.stale(run, job)) return;
      if (run.cancel_requested) return this.finishRun(c, run.id, 'CANCELLED', 'cancelled', 'cancelled during execution; fixtures cleaned up');
      await c.query(`update runs set state='VERIFYING', updated_at=now() where id=$1`, [run.id]);
      const manifest = run.selection_manifest!;
      const rows = (await c.query<{ result: CaseResult & { advisory?: boolean } }>('select result from case_results where run_id=$1 and attempt=$2', [run.id, run.attempt])).rows.map((r) => r.result);
      const required = rows.filter((r) => !r.advisory);
      const expected = manifest.cases.filter((x) => x.required).map(({ scenario_id, execution_profile }) => ({ scenario_id, execution_profile }));
      const gate = evaluateReleaseGate(
        expected,
        required.map((r) => ({ scenario_id: r.scenario_id, execution_profile: r.execution_profile, verdict: r.verdict, critical: r.critical, required: true })),
      );
      for (const r of required.filter((x) => x.cleanup.status === 'failed')) gate.reasons.push(`${r.scenario_id}@${r.execution_profile}: cleanup failed`);
      const eligible = gate.reasons.length === 0;
      const failing = required.filter((r) => r.verdict !== 'PASS').length;
      await c.query(`update runs set gate=$2, updated_at=now() where id=$1`, [run.id, JSON.stringify({ eligible, reasons: gate.reasons })]);
      await this.finishRun(c, run.id, 'COMPLETED', eligible ? null : 'gate_held', eligible ? `${required.length} required case(s) passed` : `${failing} of ${expected.length} required case(s) not passing`);
    });
  }

  private async finishRun(c: pg.PoolClient, runId: string, state: 'COMPLETED' | 'ERROR' | 'CANCELLED', reason: string | null, message: string): Promise<void> {
    const r = await c.query<{ tenant_id: string }>(
      `update runs set state=$2, reason=$3, message=$4, completed_at=now(), updated_at=now() where id=$1 and state not in ('COMPLETED','ERROR','CANCELLED','SUPERSEDED') returning tenant_id`,
      [runId, state, reason, message],
    );
    if (r.rowCount === 0) return;
    await c.query(`update jobs set state='cancelled', updated_at=now() where run_id=$1 and state='queued'`, [runId]);
    await this.orch.enqueueStatus(c, r.rows[0]!.tenant_id, runId);
  }

  // ---------- outbox ----------

  /**
   * Publish commit statuses. Each event re-reads the run, so the published
   * state is always the current truth for that SHA; a superseded or stale
   * run can never publish success.
   */
  async publishOutbox(limit = 20): Promise<number> {
    return this.db.tx(async (c) => {
      const events = (await c.query<{ id: string; tenant_id: string; kind: string; payload: { run_id: string }; attempts: number }>(
        `select id::text, tenant_id, kind, payload, attempts from outbox_events where published_at is null and available_at <= now() order by id limit $1 for update skip locked`,
        [limit],
      )).rows;
      for (const ev of events) {
        try {
          if (ev.kind !== 'publish_status') throw new Error(`unknown outbox kind ${ev.kind}`);
          const run = (await c.query<RunRow>('select * from runs where id=$1', [ev.payload.run_id])).rows[0]!;
          const project = (await this.orch.projectById(run.project_id))!;
          const dep = (await c.query<{ provider: string; provider_deployment_id: string }>('select provider, provider_deployment_id from deployments where id=$1', [run.deployment_id])).rows[0];
          await this.orch.deps.publisherFor(project).publish({
            ...(dep ? { provider: dep.provider, deployment_provider_id: dep.provider_deployment_id } : {}),
            repository: project.repository_full_name,
            sha: run.commit_sha,
            context: this.orch.statusContext(project, run.environment),
            ...statusFor(run),
            ...(project.config.status.dashboard_url ? { target_url: `${project.config.status.dashboard_url.replace(/\/$/, '')}/runs/${run.id}` } : {}),
          });
          await c.query('update outbox_events set published_at=now(), attempts=attempts+1 where id=$1', [ev.id]);
        } catch (e) {
          const delay = Math.random() * Math.min(600, 2 ** (ev.attempts + 1));
          await c.query('update outbox_events set attempts=attempts+1, last_error=$2, available_at=now() + make_interval(secs => $3) where id=$1', [ev.id, (e as Error).message, delay]);
          this.log(`outbox ${ev.id} failed: ${(e as Error).message}`);
        }
      }
      return events.length;
    });
  }
}

export function statusFor(run: RunRow): { state: 'pending' | 'success' | 'failure' | 'error'; description: string } {
  switch (run.state) {
    case 'COMPLETED':
      return run.gate?.eligible ? { state: 'success', description: run.message ?? 'all required cases passed' } : { state: 'failure', description: run.message ?? 'gate held' };
    case 'ERROR':
      return { state: 'error', description: `QA error: ${run.message ?? run.reason ?? 'unknown'}` };
    case 'CANCELLED':
      return { state: 'error', description: 'QA run cancelled' };
    case 'SUPERSEDED':
      return { state: 'error', description: run.message ?? 'superseded by a newer deployment' };
    default:
      return { state: 'pending', description: `QA ${run.state.toLowerCase().replace('_', ' ')}` };
  }
}
