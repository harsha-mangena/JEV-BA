import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { executionDedupKey, ProjectConfig, parseWith, requiredCheckContext, type SelectionManifest } from '@qa/contracts';
import type { Db } from '@qa/db';
import { DeploymentVerificationError, type DeploymentClaim, type DeploymentVerifier, type StatusPublisher } from '@qa/integrations';
import type { ArtifactStore } from '@qa/evidence';
import type { BaselineStore, VisualReviewer } from '@qa/quality';
import type { SystemOneProvider } from '@qa/s1';
import { loadSuite, selectFullSuite, type LoadedSuite } from './suite.ts';
import { describeObligation, OBLIGATION_PREFIX, outstandingObligations } from './intents.ts';
import { validateAdjudication, type Adjudication, type IntentRecord } from '@qa/worker';
import { ApiError, canSeeProject, requireRole, type Principal, type ProjectRow, type RunRow } from './types.ts';
import { checkCandidateUrl, type Resolver } from './url-policy.ts';

export interface SelectionContext {
  project: ProjectRow;
  suite: LoadedSuite;
  environment: string;
  commit_sha: string;
  /** Last accepted deployment SHA in the same environment lineage, if any. */
  baseline_sha: string | null;
}

export interface OrchestratorDeps {
  db: Db;
  verifierFor(project: ProjectRow, provider: string): DeploymentVerifier;
  publisherFor(project: ProjectRow): StatusPublisher;
  /** Directory that project suite paths are resolved against. */
  suiteBaseDir: string;
  resolveHost?: Resolver;
  env?: NodeJS.ProcessEnv;
  /** Change-aware selection; defaults to the full suite. */
  select?(ctx: SelectionContext): Promise<SelectionManifest>;
  /** Run evidence storage shared by workers, reviews and the dashboard. */
  artifacts?: ArtifactStore;
  /** Visual baseline store per project. */
  baselinesFor?(project: ProjectRow): BaselineStore;
  /** Advisory vision reviewer attached to failed visual comparisons (never approves). */
  visualReviewer?: VisualReviewer;
  /**
   * Calibration qualifications: calibrated autonomy runs only for a profile
   * (project, environment, application contract, model) qualified for the
   * calibration in use; otherwise exploration is downgraded to shadow mode.
   */
  qualifications?: { find(profile: { project_id: string; environment: string; application: string; resolved_model: string }, calibration: { id: string; decision_config_digest: string }): Promise<unknown | null> };
  /** Wraps the exploration S1 provider per tenant (quotas, circuit breaking). */
  s1For?(tenantId: string, inner: SystemOneProvider): SystemOneProvider;
}

export interface SubmitInput extends DeploymentClaim {
  repository_id: string | null;
  ci_run_id?: string;
}

export interface SubmitResult {
  run_id: string;
  state: string;
  deduplicated: boolean;
  /** Submission acceptance is not a QA result. */
  note: string;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const TERMINAL = ['COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED'];

export class Orchestrator {
  constructor(readonly deps: OrchestratorDeps) {}

  get db(): Db {
    return this.deps.db;
  }

  async audit(c: { query(sql: string, params: unknown[]): Promise<unknown> }, p: Principal | { tenant_id: string | null; actor: string }, action: string, subject: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    await c.query('insert into audit_log(tenant_id, actor, action, subject, detail) values ($1,$2,$3,$4,$5)', [p.tenant_id, p.actor, action, subject, JSON.stringify(detail)]);
  }

  // ---------- principals and projects ----------

  async authenticate(bearer: string | undefined): Promise<Principal> {
    if (!bearer) throw new ApiError(401, 'unauthenticated', 'missing bearer token');
    const row = await this.db.one<{ tenant_id: string; project_id: string | null; role: Principal['role']; label: string }>(
      'select tenant_id, project_id, role, label from api_tokens where token_hash=$1 and revoked_at is null',
      [tokenHash(bearer)],
    );
    if (!row) throw new ApiError(401, 'unauthenticated', 'invalid or revoked token');
    return { tenant_id: row.tenant_id, project_id: row.project_id, role: row.role, actor: `token:${row.label}` };
  }

  async projectById(id: string): Promise<ProjectRow | undefined> {
    const r = await this.db.one<ProjectRow>('select id, tenant_id, repository_id, repository_full_name, config, webhook_secret_ref, github_installation_id::text from projects where id=$1', [id]);
    return r ? { ...r, config: parseWith(ProjectConfig, r.config, `project ${id}`) } : undefined;
  }

  async projectByRepository(repositoryId: string): Promise<ProjectRow | undefined> {
    const r = await this.db.one<{ id: string }>('select id from projects where repository_id=$1', [repositoryId]);
    return r ? this.projectById(r.id) : undefined;
  }

  async visibleProject(p: Principal, id: string): Promise<ProjectRow> {
    const project = await this.projectById(id);
    if (!project || !canSeeProject(p, project)) throw new ApiError(404, 'not_found', 'project not found');
    return project;
  }

  async visibleRun(p: Principal, id: string): Promise<RunRow> {
    const run = await this.db.one<RunRow>('select * from runs where id=$1', [id]);
    if (!run || !canSeeProject(p, { tenant_id: run.tenant_id, id: run.project_id })) throw new ApiError(404, 'not_found', 'run not found');
    return run;
  }

  // ---------- ingestion ----------

  /**
   * Accept a deployment-ready event. The claim is verified against trusted
   * provider metadata, the URL against project policy, and the logical run is
   * deduplicated by (tenant, project, provider, deployment, suite revision,
   * profile set). Redelivery never creates a second run.
   */
  async submitDeployment(p: Principal, project: ProjectRow, input: SubmitInput, delivery: { provider: string; delivery_id: string; payload_digest: string }): Promise<SubmitResult> {
    // Concurrent duplicates race on unique constraints; the loser re-reads and returns the winner's run.
    for (let i = 0; ; i++) {
      try {
        return await this.submitOnce(p, project, input, delivery);
      } catch (e) {
        if ((e as { code?: string }).code !== '23505' || i >= 3) throw e;
      }
    }
  }

  private async submitOnce(p: Principal, project: ProjectRow, input: SubmitInput, delivery: { provider: string; delivery_id: string; payload_digest: string }): Promise<SubmitResult> {
    requireRole(p, 'submitter');
    if (!canSeeProject(p, project)) throw new ApiError(404, 'not_found', 'project not found');
    if (input.repository_id !== null && project.repository_id !== null && input.repository_id !== project.repository_id) {
      throw new ApiError(403, 'repository_mismatch', 'event repository is not bound to this project');
    }

    const prior = await this.db.one<{ run_id: string | null; outcome: string; detail: string | null; payload_digest: string }>('select run_id, outcome, detail, payload_digest from event_deliveries where provider=$1 and delivery_id=$2', [delivery.provider, delivery.delivery_id]);
    if (prior && prior.payload_digest !== delivery.payload_digest) {
      // A redelivery must be byte-identical; a reused delivery id with another payload is a replay or a bug.
      await this.audit(this.db, p, 'deployment.delivery_conflict', project.id, { delivery_id: delivery.delivery_id });
      throw new ApiError(409, 'delivery_payload_mismatch', 'this delivery id was already received with a different payload');
    }
    if (prior) {
      if (prior.run_id) {
        const run = await this.db.one<RunRow>('select * from runs where id=$1', [prior.run_id]);
        return { run_id: prior.run_id, state: run?.state ?? 'UNKNOWN', deduplicated: true, note: 'redelivery of an accepted event' };
      }
      throw new ApiError(409, 'delivery_already_rejected', `delivery previously ${prior.outcome}: ${prior.detail ?? ''}`);
    }
    const reject = async (status: number, code: string, message: string, detail?: unknown): Promise<never> => {
      await this.db.query('insert into event_deliveries(provider, delivery_id, tenant_id, project_id, payload_digest, outcome, detail) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [delivery.provider, delivery.delivery_id, project.tenant_id, project.id, delivery.payload_digest, 'rejected', `${code}: ${message}`]);
      await this.audit(this.db, p, 'deployment.rejected', project.id, { code, message });
      throw new ApiError(status, code, message, detail);
    };

    const envCfg = project.config.environments[input.environment];
    if (!envCfg) return reject(422, 'environment_not_configured', `environment ${input.environment} is not configured`);
    if (!/^[0-9a-f]{40}$/.test(input.commit_sha)) return reject(422, 'invalid_sha', 'commit_sha must be a full 40-character SHA');

    let verified;
    try {
      verified = await this.deps.verifierFor(project, input.provider).verify({ ...input, repository: project.repository_full_name });
    } catch (e) {
      if (e instanceof DeploymentVerificationError) return reject(422, 'deployment_unverified', e.message, e.checks);
      return reject(502, 'provider_lookup_failed', (e as Error).message);
    }
    const urlProblems = await checkCandidateUrl(verified.immutable_url, envCfg, this.deps.resolveHost);
    if (urlProblems.length) return reject(422, 'url_rejected', urlProblems.join('; '), urlProblems);

    let suite: LoadedSuite;
    try {
      suite = await loadSuite(project.config, this.deps.suiteBaseDir);
    } catch (e) {
      return reject(500, 'suite_invalid', (e as Error).message);
    }
    const baseline = await this.db.one<{ commit_sha: string }>(
      `select r.commit_sha from runs r where r.project_id=$1 and r.environment=$2 and r.state='COMPLETED' and (r.gate->>'eligible')::boolean order by r.completed_at desc limit 1`,
      [project.id, verified.environment],
    );
    const manifest = await (this.deps.select ?? (async (c) => selectFullSuite(c.suite, c.project.config, c.environment, c.commit_sha)))({
      project,
      suite,
      environment: verified.environment,
      commit_sha: verified.commit_sha,
      baseline_sha: baseline?.commit_sha ?? null,
    });
    if (envCfg.read_only) restrictToReadOnly(manifest, suite);
    const profileSet = [...new Set(manifest.cases.map((c) => c.execution_profile))].sort().join('+') || 'none';
    const dedupKey = executionDedupKey({ tenant_id: project.tenant_id, project_id: project.id, provider: input.provider, deployment_id: verified.deployment_id, suite_revision: suite.revision, execution_profile: profileSet });

    return this.db.tx(async (c) => {
      const dep = await c.query<{ id: string; commit_sha: string; immutable_url: string }>(
        `insert into deployments(id, tenant_id, project_id, provider, provider_deployment_id, environment, immutable_url, commit_sha, manifest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (project_id, provider, provider_deployment_id) do update set provider_deployment_id = excluded.provider_deployment_id
         returning id, commit_sha, immutable_url`,
        [newId('dep'), project.tenant_id, project.id, input.provider, verified.deployment_id, verified.environment, verified.immutable_url, verified.commit_sha, JSON.stringify({ ...verified, verified_at: new Date().toISOString() })],
      );
      const deployment = dep.rows[0]!;
      if (deployment.commit_sha !== verified.commit_sha || deployment.immutable_url !== verified.immutable_url) {
        throw new ApiError(409, 'deployment_mutated', 'a deployment id cannot change its SHA or URL');
      }
      const runId = newId('run');
      const inserted = await c.query<RunRow>(
        `insert into runs(id, tenant_id, project_id, deployment_id, environment, commit_sha, suite_revision, execution_profile, dedup_key, state, selection_manifest, execution_snapshot, generation)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'WAITING_READY',$10,$11,
                 (select coalesce(max(generation), 0) + 1 from runs where project_id=$3 and environment=$5)) on conflict (dedup_key) do nothing returning *`,
        [runId, project.tenant_id, project.id, deployment.id, verified.environment, verified.commit_sha, suite.revision, profileSet, dedupKey, JSON.stringify(manifest), JSON.stringify(suite.snapshot)],
      );
      const deduplicated = inserted.rowCount === 0;
      const run = deduplicated ? (await c.query<RunRow>('select * from runs where dedup_key=$1', [dedupKey])).rows[0]! : inserted.rows[0]!;
      await c.query('insert into event_deliveries(provider, delivery_id, tenant_id, project_id, payload_digest, outcome, run_id) values ($1,$2,$3,$4,$5,$6,$7)', [delivery.provider, delivery.delivery_id, project.tenant_id, project.id, delivery.payload_digest, deduplicated ? 'deduplicated' : 'accepted', run.id]);
      if (!deduplicated) {
        // A newer deployment in the same environment supersedes older unfinished runs.
        const superseded = await c.query<{ id: string }>(
          `update runs set state='SUPERSEDED', superseded_by=$1, reason='superseded', message=$2, updated_at=now(), completed_at=now()
           where project_id=$3 and environment=$4 and deployment_id<>$5 and state not in ('COMPLETED','ERROR','CANCELLED','SUPERSEDED') returning id`,
          [run.id, `superseded by deployment ${verified.deployment_id}`, project.id, verified.environment, deployment.id],
        );
        for (const s of superseded.rows) {
          await c.query(`update jobs set state='cancelled', updated_at=now() where run_id=$1 and state='queued'`, [s.id]);
          await this.enqueueStatus(c, project.tenant_id, s.id);
        }
        await c.query('insert into jobs(tenant_id, run_id, kind, payload) values ($1,$2,$3,$4)', [project.tenant_id, run.id, 'readiness', JSON.stringify({ attempt: 1 })]);
        await this.enqueueStatus(c, project.tenant_id, run.id);
        await this.audit(c, p, 'run.created', run.id, { deployment: verified.deployment_id, sha: verified.commit_sha, suite: suite.revision, superseded: superseded.rows.map((r) => r.id) });
      }
      return { run_id: run.id, state: run.state, deduplicated, note: 'accepted for testing; this is not a QA result — wait for the required check' };
    });
  }

  async enqueueStatus(c: pg.ClientBase, tenantId: string, runId: string): Promise<void> {
    await c.query('insert into outbox_events(tenant_id, kind, payload) values ($1,$2,$3)', [tenantId, 'publish_status', JSON.stringify({ run_id: runId })]);
  }

  // ---------- run control ----------

  async getRun(p: Principal, id: string) {
    const run = await this.visibleRun(p, id);
    const cases = (await this.db.query('select attempt, shard, scenario_id, execution_profile, verdict, result, run_dir from case_results where run_id=$1 order by attempt, scenario_id, execution_profile', [id])).rows;
    const deployment = await this.db.one('select provider, provider_deployment_id, environment, immutable_url, commit_sha from deployments where id=$1', [run.deployment_id]);
    return { run, deployment, cases };
  }

  async cancelRun(p: Principal, id: string): Promise<RunRow> {
    requireRole(p, 'submitter');
    const run = await this.visibleRun(p, id);
    if (TERMINAL.includes(run.state)) throw new ApiError(409, 'terminal', `run is already ${run.state}`);
    return this.db.tx(async (c) => {
      await c.query('update runs set cancel_requested=true, updated_at=now() where id=$1', [id]);
      // Anything not actively executing is cancelled immediately; an executing shard aborts at its next checkpoint and still cleans up.
      const leased = await c.query(`select 1 from jobs where run_id=$1 and state='leased' and kind='execute_shard'`, [id]);
      if (leased.rowCount === 0) {
        await c.query(`update runs set state='CANCELLED', reason='cancelled', message='cancelled on request', completed_at=now(), updated_at=now() where id=$1 and state not in ('COMPLETED','ERROR','CANCELLED','SUPERSEDED')`, [id]);
        await c.query(`update jobs set state='cancelled', updated_at=now() where run_id=$1 and state in ('queued','leased')`, [id]);
        await this.enqueueStatus(c, run.tenant_id, id);
      }
      await this.audit(c, p, 'run.cancel', id);
      return (await c.query<RunRow>('select * from runs where id=$1', [id])).rows[0]!;
    });
  }

  /** A deliberate rerun: new attempt of the same logical run; earlier attempts' results are preserved. */
  async retryRun(p: Principal, id: string, reason: string): Promise<RunRow> {
    requireRole(p, 'submitter');
    if (!reason?.trim()) throw new ApiError(400, 'reason_required', 'a retry requires an explicit reason');
    const run = await this.visibleRun(p, id);
    if (!['COMPLETED', 'ERROR', 'CANCELLED'].includes(run.state)) throw new ApiError(409, 'not_retryable', `cannot retry a run in state ${run.state}`);
    const current = await this.db.one<{ id: string }>('select id from deployments where project_id=$1 and environment=$2 order by created_at desc limit 1', [run.project_id, run.environment]);
    if (current?.id !== run.deployment_id) throw new ApiError(409, 'not_current', 'a newer deployment exists; retrying an old deployment cannot affect its gate');
    return this.db.tx(async (c) => {
      const r = await c.query<RunRow>(
        `update runs set attempt=attempt+1, state='WAITING_READY', gate=null, reason=null, message=null, cancel_requested=false, completed_at=null, updated_at=now() where id=$1 and state=$2 returning *`,
        [id, run.state],
      );
      if (r.rowCount === 0) throw new ApiError(409, 'conflict', 'run changed concurrently');
      await c.query('insert into jobs(tenant_id, run_id, kind, payload) values ($1,$2,$3,$4)', [run.tenant_id, id, 'readiness', JSON.stringify({ attempt: r.rows[0]!.attempt })]);
      await this.enqueueStatus(c, run.tenant_id, id);
      await this.audit(c, p, 'run.retry', id, { reason, attempt: r.rows[0]!.attempt });
      return r.rows[0]!;
    });
  }

  /**
   * What a promotion controller consumes. Eligible only when the requested
   * deployment is the environment's current candidate, the SHA matches, the
   * suite has not changed since, and that exact run completed with an
   * eligible gate. A late result for an older deployment can never apply.
   */
  async gateStatus(p: Principal, q: { project_id: string; environment: string; deployment_id: string; commit_sha: string }) {
    const project = await this.visibleProject(p, q.project_id);
    const reasons: string[] = [];
    const current = await this.db.one<{ id: string; provider_deployment_id: string; commit_sha: string }>(
      'select id, provider_deployment_id, commit_sha from deployments where project_id=$1 and environment=$2 order by created_at desc limit 1',
      [project.id, q.environment],
    );
    if (!current) return { eligible: false, reasons: ['no deployment registered for this environment'] };
    if (current.provider_deployment_id !== q.deployment_id) reasons.push(`deployment ${q.deployment_id} is not the current candidate (${current.provider_deployment_id})`);
    if (current.commit_sha !== q.commit_sha) reasons.push('commit SHA does not match the current candidate');
    const run = await this.db.one<RunRow>('select * from runs where deployment_id=$1 order by created_at desc limit 1', [current.id]);
    if (!run) reasons.push('no QA run for the current candidate');
    else {
      const suite = await loadSuite(project.config, this.deps.suiteBaseDir).catch(() => null);
      if (!suite || suite.revision !== run.suite_revision) reasons.push('suite or policy changed since the run; results are stale');
      if (run.state !== 'COMPLETED') reasons.push(`run ${run.id} is ${run.state}`);
      // Obligations recorded at aggregation are re-evaluated live below (an adjudication resolves them); everything else stands.
      else if (!run.gate?.eligible) reasons.push(...(run.gate?.reasons ?? ['gate held']).filter((r) => !r.startsWith(OBLIGATION_PREFIX)));
    }
    // Re-checked live: an obligation left by any run of this deployment holds promotion until it is resolved or adjudicated.
    for (const x of await outstandingObligations(this.db, current.id, { includeLive: true })) {
      const why = describeObligation(x);
      if (!reasons.includes(why)) reasons.push(why);
    }
    return { eligible: reasons.length === 0, run_id: run?.id ?? null, reasons };
  }

  /** Effect obligations still open for a run's deployment (what holds its gate), for operators to adjudicate. */
  async obligations(p: Principal, runId: string) {
    const run = await this.visibleRun(p, runId);
    return outstandingObligations(this.db, run.deployment_id, { includeLive: true });
  }

  /**
   * Record an authorized decision about an effect the system could not verify
   * (NEEDS_REVIEW). It resolves the obligation only; the held case is not
   * re-run until someone retries the run, and the decision is audited.
   */
  async adjudicateIntent(p: Principal, intentId: string, a: { resolution: string; note: string }) {
    requireRole(p, 'admin');
    return this.db.tx(async (c) => {
      const row = (await c.query<{ intent_id: string; tenant_id: string; run_id: string; state: string; effect: string; adjudication: unknown }>('select intent_id, tenant_id, run_id, state, effect, adjudication from action_intents where intent_id=$1 for update', [intentId])).rows[0];
      const run = row ? await c.query<{ project_id: string }>('select project_id from runs where id=$1', [row.run_id]).then((r) => r.rows[0]) : undefined;
      if (!row || !run || !canSeeProject(p, { tenant_id: row.tenant_id, id: run.project_id })) throw new ApiError(404, 'not_found', 'intent not found');
      const adjudication: Adjudication = { resolution: a.resolution as Adjudication['resolution'], by: p.actor, note: a.note };
      try {
        validateAdjudication({ ...row, adjudication: row.adjudication } as unknown as IntentRecord, intentId, adjudication);
      } catch (e) {
        throw new ApiError(409, 'not_adjudicable', (e as Error).message);
      }
      const recorded = { ...adjudication, at: new Date().toISOString() };
      await c.query('update action_intents set adjudication=$2, updated_at=now() where intent_id=$1', [intentId, JSON.stringify(recorded)]);
      await this.audit(c, p, 'intent.adjudicate', intentId, recorded as unknown as Record<string, unknown>);
      return { intent_id: intentId, adjudication: recorded };
    });
  }

  /**
   * Record a promotion decision for exactly one candidate: the gate evaluated
   * now, bound to the run attempt, suite revision and generation it relied on.
   * The decision expires and can be consumed once.
   */
  async decidePromotion(p: Principal, q: { project_id: string; environment: string; deployment_id: string; commit_sha: string; ttl_seconds?: number }) {
    requireRole(p, 'submitter');
    const project = await this.visibleProject(p, q.project_id);
    const g = await this.gateStatus(p, q);
    const run = g.run_id ? await this.db.one<RunRow & { generation: string | null }>('select * from runs where id=$1', [g.run_id]) : undefined;
    const id = newId('prom');
    const ttl = Math.min(Math.max(q.ttl_seconds ?? 900, 30), 86_400);
    await this.db.tx(async (c) => {
      await c.query(
        `insert into promotion_decisions(id, tenant_id, project_id, environment, provider_deployment_id, commit_sha, run_id, run_attempt, suite_revision, generation, eligible, reasons, decided_by, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(secs => $14))`,
        [id, project.tenant_id, project.id, q.environment, q.deployment_id, q.commit_sha, run?.id ?? null, run?.attempt ?? null, run?.suite_revision ?? null, run?.generation ?? null, g.eligible, JSON.stringify(g.reasons), p.actor, ttl],
      );
      await this.audit(c, p, 'promotion.decide', id, { eligible: g.eligible, reasons: g.reasons, run: run?.id ?? null });
    });
    return { decision_id: id, eligible: g.eligible, reasons: g.reasons, run_id: run?.id ?? null, expires_in_seconds: ttl };
  }

  /**
   * Consume a promotion decision exactly once. It succeeds only if the
   * decision was eligible, has not expired or been consumed, and the gate
   * still holds for the same run attempt, suite revision and newest
   * generation; otherwise it is consumed as `refused` with the reasons.
   */
  async consumePromotion(p: Principal, decisionId: string) {
    requireRole(p, 'submitter');
    return this.db.tx(async (c) => {
      const d = (await c.query<{ id: string; tenant_id: string; project_id: string; environment: string; provider_deployment_id: string; commit_sha: string; run_id: string | null; run_attempt: number | null; suite_revision: string | null; generation: string | null; eligible: boolean; expired: boolean; consumed_at: string | null }>(
        'select *, expires_at < now() as expired from promotion_decisions where id=$1 for update',
        [decisionId],
      )).rows[0];
      if (!d || !canSeeProject(p, { tenant_id: d.tenant_id, id: d.project_id })) throw new ApiError(404, 'not_found', 'promotion decision not found');
      if (d.consumed_at) throw new ApiError(409, 'already_consumed', 'this promotion decision was already used');
      const reasons: string[] = [];
      if (!d.eligible) reasons.push('the decision was not eligible');
      if (d.expired) reasons.push('the decision has expired');
      if (reasons.length === 0) {
        const g = await this.gateStatus(p, { project_id: d.project_id, environment: d.environment, deployment_id: d.provider_deployment_id, commit_sha: d.commit_sha });
        if (!g.eligible) reasons.push(...g.reasons);
        const run = d.run_id ? (await c.query<{ attempt: number; suite_revision: string; generation: string }>('select attempt, suite_revision, generation::text from runs where id=$1', [d.run_id])).rows[0] : undefined;
        if (!run || g.run_id !== d.run_id) reasons.push('the gate now relies on a different run');
        else {
          if (run.attempt !== d.run_attempt) reasons.push(`run attempt changed (${d.run_attempt} → ${run.attempt})`);
          if (run.suite_revision !== d.suite_revision) reasons.push('suite revision changed since the decision');
        }
        const newest = (await c.query<{ g: string | null }>('select max(generation)::text g from runs where project_id=$1 and environment=$2', [d.project_id, d.environment])).rows[0]?.g ?? null;
        if (d.generation !== null && newest !== null && newest !== String(d.generation)) reasons.push(`a newer run generation exists (${d.generation} → ${newest})`);
      }
      const outcome = reasons.length ? 'refused' : 'promoted';
      await c.query('update promotion_decisions set consumed_at=now(), consumed_by=$2, consume_outcome=$3 where id=$1', [decisionId, p.actor, outcome]);
      await this.audit(c, p, 'promotion.consume', decisionId, { outcome, reasons });
      return { decision_id: decisionId, promoted: outcome === 'promoted', reasons };
    });
  }

  statusContext(project: ProjectRow, environment: string): string {
    return requiredCheckContext(project.config, project.id, environment);
  }
}

/** Production (read-only) environments run only fixture-less, non-mutating regression scenarios. */
export function restrictToReadOnly(manifest: SelectionManifest, suite: LoadedSuite): void {
  const ok = new Set(suite.scenarios.filter((s) => !s.fixture && s.policy.mutations.length === 0 && s.milestones.every((m) => m.steps.every((st) => !st.intent))).map((s) => s.id));
  const dropped = [...new Set(manifest.cases.filter((c) => !ok.has(c.scenario_id)).map((c) => c.scenario_id))];
  manifest.cases = manifest.cases.filter((c) => ok.has(c.scenario_id));
  for (const id of dropped) manifest.omitted.push({ scenario_id: id, reason: 'read-only environment: scenario provisions fixtures or mutates' });
  for (const e of manifest.exploration) manifest.omitted.push({ scenario_id: e.scenario_id, reason: 'read-only environment: exploration disabled' });
  manifest.exploration = [];
  manifest.explanation.push('read-only capability profile applied');
}
