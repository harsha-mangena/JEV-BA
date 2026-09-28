import { hostname } from 'node:os';
import type pg from 'pg';
import { evaluateReleaseGate, type CaseResult, type ExecutionProfileId } from '@qa/contracts';
import { FixtureClient } from '@qa/oracles';
import { recoverIntents, runSuite, type ExplorationOptions } from '@qa/worker';
import { autonomyMode, type GateConfig } from '@qa/gate';
import { describeObligation, outstandingObligations, PgIntentStore } from './intents.ts';
import { FrozenBaselineStore } from '@qa/quality';
import { basename } from 'node:path';
import { uploadDir } from '@qa/evidence';
import { FindingLedger } from '@qa/quality';
import { checkReadiness, readRevision } from './readiness.ts';
import { Sweeper } from './sweepers.ts';
import { newId, type Orchestrator } from './service.ts';
import { contractChanges, loadSuite, selectionDigest, shard } from './suite.ts';
import type { ProjectRow, RunRow } from './types.ts';

export interface Job {
  id: string;
  tenant_id: string;
  run_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  /** Lease fence: incremented on every lease; writes are accepted only under the current fence. */
  fence: number;
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

  /**
   * Lease one job with atomic tenant admission: the tenant row is locked
   * while its active leases are counted, so concurrent workers can never
   * exceed a tenant's quota. Tenants with the fewest active leases go first.
   * Each lease increments the job's fence; every later write is fenced.
   */
  async lease(): Promise<Job | null> {
    const lease = this.o.leaseSeconds ?? 60;
    const ready = `((j.state='queued' and j.available_at <= now()) or (j.state='leased' and j.lease_expires_at < now()))`;
    return this.db.tx(async (c) => {
      const tenants = (await c.query<{ id: string }>(
        `select t.id from tenants t
         where exists (select 1 from jobs j where j.tenant_id = t.id and ${ready})
         order by (select count(*) from jobs a where a.tenant_id = t.id and a.state='leased' and a.lease_expires_at >= now()), t.id`,
      )).rows;
      for (const t of tenants) {
        const locked = await c.query<{ max_concurrent_jobs: number }>('select max_concurrent_jobs from tenants where id=$1 for update skip locked', [t.id]);
        if (locked.rowCount === 0) continue;
        const active = (await c.query<{ n: number }>(`select count(*)::int n from jobs where tenant_id=$1 and state='leased' and lease_expires_at >= now()`, [t.id])).rows[0]!.n;
        if (active >= locked.rows[0]!.max_concurrent_jobs) continue;
        const r = await c.query<Job>(
          `update jobs set state='leased', lease_owner=$1, lease_expires_at=now() + make_interval(secs => $2), attempts=attempts+1, fence=fence+1, updated_at=now()
           where id = (select j.id from jobs j where j.tenant_id=$3 and ${ready} order by j.available_at, j.id limit 1 for update skip locked)
           returning id::text, tenant_id, run_id, kind, payload, attempts, max_attempts, fence::int`,
          [this.id, lease, t.id],
        );
        if (r.rows[0]) return r.rows[0];
      }
      return null;
    });
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
      void this.db.query(`update jobs set lease_expires_at=now() + make_interval(secs => $3) where id=$1 and fence=$2 and state='leased'`, [job.id, job.fence, lease]).catch(() => undefined);
    }, (lease * 1000) / 3);
    try {
      this.log(`${job.kind} ${job.run_id ?? ''} (attempt ${job.attempts})`);
      await this.handle(job);
      await this.db.query(`update jobs set state='done', updated_at=now() where id=$1 and fence=$2 and state='leased'`, [job.id, job.fence]);
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`${job.kind} failed: ${msg}`);
      if (job.attempts >= job.max_attempts) await this.failPermanently(job, msg);
      else {
        // Full jitter, capped: spreads retries after shared outages.
        const delay = Math.random() * Math.min(300, 2 ** job.attempts);
        await this.db.query(`update jobs set state='queued', lease_owner=null, lease_expires_at=null, last_error=$2, available_at=now() + make_interval(secs => $3), updated_at=now() where id=$1 and fence=$4 and state='leased'`, [job.id, msg, delay, job.fence]);
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
    // Execute only under the exact contract the run was selected under (including changes made while it is in progress).
    const exec = await this.orch.resolveExecution(project, run.environment, suite);
    if (exec.revision !== run.suite_revision) throw new Error(`execution contract changed since selection (${run.suite_revision} → ${exec.revision}: ${contractChanges(run.execution_snapshot, exec.contract).join('; ')})`);
    if (run.selection_digest && selectionDigest(run.selection_manifest!) !== run.selection_digest) throw new Error('selection manifest does not match the identity frozen at submission');
    const baselineStore = this.orch.deps.baselinesFor?.(project) ?? null;
    const env = this.o.env ?? process.env;
    const readOnly = cfg.environments[run.environment]?.read_only === true;
    const token = env[cfg.fixture_api.token_env];
    if (!token && !readOnly) throw new Error(`fixture token variable ${cfg.fixture_api.token_env} is not set`);
    const fixtures = new FixtureClient(cfg.fixture_api.url ?? url, token ?? 'read-only-profile-has-no-fixture-access');
    const cases = job.payload.cases as Array<{ scenario_id: string; execution_profile: ExecutionProfileId }>;
    const advisory = job.payload.advisory === true;

    // Resolve anything an earlier lease or attempt may have dispatched for these cases before running them again.
    const intents = new PgIntentStore(this.db, { tenant_id: run.tenant_id, run_id: run.id, run_attempt: run.attempt, shard: Number(job.payload.shard), job_id: job.id, fence: job.fence, cases });
    for (const r of await recoverIntents(intents, fixtures, { settleMs: 10_000 })) this.log(`recovered intent ${r.intent_id}: ${r.state} (${r.detail ?? ''})`);
    // A case whose earlier effect is still uncertain is never replayed: replaying could duplicate an effect nobody has
    // accounted for. It is reported as NEEDS_REVIEW until the obligation is adjudicated and the run is retried.
    const held = new Map<string, string[]>();
    for (const r of await intents.outstanding()) {
      const k = `${r.scenario_id}@${r.execution_profile}`;
      held.set(k, [...(held.get(k) ?? []), `${r.intent_id} (${r.contract_intent ?? r.effect}) is ${r.state}${r.detail ? `: ${r.detail}` : ''}`]);
    }
    const runnable = cases.filter((c) => !held.has(`${c.scenario_id}@${c.execution_profile}`));
    const heldResults: CaseResult[] = cases
      .filter((c) => held.has(`${c.scenario_id}@${c.execution_profile}`))
      .map((c) => {
        const sc = suite.scenarios.find((x) => x.id === c.scenario_id);
        const now = new Date().toISOString();
        this.log(`not replaying ${c.scenario_id}@${c.execution_profile}: ${held.get(`${c.scenario_id}@${c.execution_profile}`)!.join('; ')}`);
        return {
          scenario_id: c.scenario_id,
          requirement_ids: sc?.requirement_ids ?? [],
          execution_profile: c.execution_profile,
          attempt_id: `${c.scenario_id}.${c.execution_profile}.held.f${job.fence}`,
          critical: sc?.critical ?? true,
          verdict: 'NEEDS_REVIEW',
          reason: 'effect_unreconciled',
          message: `not replayed: an earlier effect is unresolved — ${held.get(`${c.scenario_id}@${c.execution_profile}`)!.join('; ')}. Adjudicate the intent, then retry the run.`,
          started_at: now,
          finished_at: now,
          milestones_completed: [],
          assertions: [],
          artifacts: [],
          cleanup: { status: 'skipped', detail: 'not executed' },
          prior_attempts: [],
        } satisfies CaseResult;
      });

    const ac = new AbortController();
    const poll = setInterval(() => {
      void this.db
        .one<{ state: string; cancel_requested: boolean; attempt: number; fence: number | null }>('select state, cancel_requested, attempt, (select fence::int from jobs where id=$2) fence from runs where id=$1', [run.id, job.id])
        .then((r) => {
          // A lost fence means another worker now owns this shard: stop dispatching at once.
          if (!r || r.cancel_requested || r.state === 'SUPERSEDED' || r.state === 'CANCELLED' || r.attempt !== run.attempt || r.fence !== job.fence) ac.abort();
        })
        .catch(() => undefined);
    }, this.o.cancelPollMs ?? 1000);
    let results: CaseResult[] = [];
    let runDirKey: string | null = null;
    const ledger = new FindingLedger();
    try {
      if (runnable.length === 0) throw new NothingToRun();
      const { report, runDir } = await runSuite({
        quality: { baselines: baselineStore ? new FrozenBaselineStore(baselineStore, exec.contract.baselines) : null, findings: ledger, commitSha: run.commit_sha, ...(this.orch.deps.visualReviewer ? { reviewer: this.orch.deps.visualReviewer } : {}) },
        scenarios: suite.scenarios.filter((s) => runnable.some((c) => c.scenario_id === s.id)),
        policy: suite.policy,
        baseUrl: url,
        environment: run.environment,
        fixtures,
        outDir: this.o.outDir,
        runId: `${run.id}.a${run.attempt}.s${String(job.payload.shard)}`,
        commitSha: run.commit_sha,
        revision: () => readRevision(url, cfg.version_check),
        deploymentId: run.deployment_id,
        cases: runnable,
        browserVersions: Object.fromEntries(Object.values(exec.contract.rendering.profiles).map((p) => [p.browser, p.browser_version])),
        retries: cfg.suite.retries,
        concurrency: cfg.suite.concurrency,
        signal: ac.signal,
        intents,
        ...(readOnly ? { readOnly: true } : {}),
        ...(cfg.suite.signed_out_path ? { signedOutPath: cfg.suite.signed_out_path } : {}),
        ...(advisory && this.o.exploration ? { exploration: { ...this.o.exploration, s1: this.orch.deps.s1For?.(run.tenant_id, this.o.exploration.s1) ?? this.o.exploration.s1, gate: await this.qualifiedGate(project.id, run.environment, suite.policy.contract_version) } } : {}),
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
    } catch (e) {
      if (!(e instanceof NothingToRun)) throw e;
    } finally {
      clearInterval(poll);
    }
    results = [...results, ...heldResults];

    await this.db.tx(async (c) => {
      const cur = (await c.query<RunRow>('select * from runs where id=$1 for update', [run.id])).rows[0]!;
      const owned = await c.query(`update jobs set state='done', updated_at=now() where id=$1 and fence=$2 and state='leased'`, [job.id, job.fence]);
      if (owned.rowCount === 0) throw new Error(`lease lost (fence ${job.fence}); results discarded (another worker owns this shard)`);
      if (cur.attempt === run.attempt) {
        for (const r of results) {
          await c.query(
            `insert into case_results(run_id, attempt, shard, scenario_id, execution_profile, verdict, result, run_dir, fence) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
            [run.id, run.attempt, Number(job.payload.shard), r.scenario_id, r.execution_profile, r.verdict, JSON.stringify({ ...r, advisory }), runDirKey, job.fence],
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

  /** Calibrated autonomy only for a qualified profile; anything else is downgraded to shadow (decide, never act). */
  private async qualifiedGate(projectId: string, environment: string, application: string): Promise<GateConfig | undefined> {
    const gate = this.o.exploration?.gate;
    if (!gate || autonomyMode(gate) !== 'calibrated') return gate;
    const cal = gate.calibrated;
    const q = cal && this.orch.deps.qualifications ? await this.orch.deps.qualifications.find({ project_id: projectId, environment, application, resolved_model: cal.model ?? '' }, { id: cal.version_id, decision_config_digest: cal.decision_config_digest }).catch(() => null) : null;
    if (q) return gate;
    this.log(`calibrated autonomy is not qualified for ${projectId}/${environment} (${application}); running exploration in shadow mode`);
    return { ...gate, mode: 'shadow' };
  }

  /** When no shard of this attempt is still pending, schedule exactly one aggregation. */
  private async settleShard(c: pg.PoolClient, runId: string, attempt: number): Promise<void> {
    await c.query('select id from runs where id=$1 for update', [runId]);
    // Budget separation: advisory exploration never delays or blocks the required gate.
    const pending = await c.query(`select 1 from jobs where run_id=$1 and kind='execute_shard' and (payload->>'attempt')::int=$2 and state in ('queued','leased') and coalesce((payload->>'advisory')::boolean, false) = false`, [runId, attempt]);
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
      // A contract change after execution (while the run was in progress) makes these results stale too.
      const project = await this.orch.projectById(run.project_id);
      if (project) gate.reasons.push(...(await this.orch.staleness(project, run.environment, run)));
      // Fresh passing results never erase an uncertain effect left by an earlier fence or attempt.
      for (const x of await outstandingObligations(c, run.deployment_id, { includeLive: false })) gate.reasons.push(describeObligation(x));
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
      const done = new Set<string>();
      for (const ev of events) {
        if (done.has(ev.id)) continue;
        try {
          if (ev.kind !== 'publish_status') throw new Error(`unknown outbox kind ${ev.kind}`);
          // One publisher per run at a time: the run state is read and published under the lock, so a
          // slower publisher can never overwrite a newer status with an older one.
          const locked = (await c.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtext('outbox:' || $1)) ok`, [ev.payload.run_id])).rows[0]!.ok;
          if (!locked) continue;
          // Other events for this run in this (locked) batch were enqueued before the state read below,
          // so publishing the current state satisfies them; later events stay queued.
          const same = events.filter((x) => x.id !== ev.id && x.kind === ev.kind && x.payload.run_id === ev.payload.run_id).map((x) => x.id);
          if (same.length) await c.query('update outbox_events set published_at=now(), attempts=attempts+1 where id = any($1::bigint[])', [same]);
          for (const id of same) done.add(id);
          const run = (await c.query<RunRow>('select * from runs where id=$1', [ev.payload.run_id])).rows[0]!;
          // A late publication for a candidate that is no longer current must not overwrite the status its lineage's
          // current candidate owns for the same SHA and context (e.g. two deployments of one commit).
          const owner = (await c.query<{ id: string; commit_sha: string }>(
            'select d.id, d.commit_sha from deployment_channels ch join deployments d on d.id = ch.current_deployment_id where ch.project_id=$1 and ch.environment=$2 and ch.channel=$3',
            [run.project_id, run.environment, run.channel ?? 'default'],
          )).rows[0];
          if (owner && owner.id !== run.deployment_id && owner.commit_sha === run.commit_sha) {
            await c.query('update outbox_events set published_at=now(), attempts=attempts+1, last_error=$2 where id=$1', [ev.id, 'skipped: a newer candidate of this lineage owns the status for this commit']);
            continue;
          }
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

/** Every case of a shard is held by an unresolved obligation; nothing is executed. */
class NothingToRun extends Error {}
