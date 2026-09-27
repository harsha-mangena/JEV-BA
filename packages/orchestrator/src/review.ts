import { isAbsolute, resolve } from 'node:path';
import { ProjectConfig, parseWith, type CaseResult } from '@qa/contracts';
import { approveProposalFile, loadCoverageGraph } from '@qa/coverage';
import type { BaselineKey } from '@qa/quality';
import { newToken } from './admin.ts';
import { tokenHash, type Orchestrator } from './service.ts';
import { loadSuite } from './suite.ts';
import { ApiError, requireRole, type Principal, type Role } from './types.ts';

/**
 * Human review and administration. Every mutation requires an explicit role,
 * is tenant-scoped, and is written to the audit log. Model providers have no
 * path to any of these operations.
 */
export class ReviewService {
  constructor(private readonly orch: Orchestrator) {}

  private get db() {
    return this.orch.db;
  }

  // ---------- onboarding ----------

  async upsertProject(p: Principal, input: { id: string; repository_id?: string; repository_full_name?: string; config: unknown; webhook_secret_ref?: string; github_installation_id?: number }) {
    requireRole(p, 'admin');
    if (p.project_id !== null && p.project_id !== input.id) throw new ApiError(403, 'forbidden', 'a project-scoped admin can only update its own project');
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.id)) throw new ApiError(400, 'invalid_id', 'project id must be lowercase letters, digits and dashes');
    const config = parseWith(ProjectConfig, input.config, `project ${input.id}`);
    const existing = await this.db.one<{ tenant_id: string }>('select tenant_id from projects where id=$1', [input.id]);
    if (existing && existing.tenant_id !== p.tenant_id) throw new ApiError(409, 'conflict', 'project id is taken');
    await this.db.tx(async (c) => {
      await c.query(
        `insert into projects(id, tenant_id, repository_id, repository_full_name, config, webhook_secret_ref, github_installation_id) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (id) do update set repository_id=excluded.repository_id, repository_full_name=excluded.repository_full_name, config=excluded.config, webhook_secret_ref=excluded.webhook_secret_ref, github_installation_id=excluded.github_installation_id`,
        [input.id, p.tenant_id, input.repository_id ?? null, input.repository_full_name ?? null, JSON.stringify(config), input.webhook_secret_ref ?? null, input.github_installation_id ?? null],
      );
      await this.orch.audit(c, p, existing ? 'project.update' : 'project.create', input.id, { repository: input.repository_full_name ?? null, environments: Object.keys(config.environments) });
    });
    return this.orch.projectById(input.id);
  }

  async createToken(p: Principal, input: { role: Role; label: string; project_id?: string | null }) {
    requireRole(p, 'admin');
    if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(input.label)) throw new ApiError(400, 'invalid_label', 'label must be a short slug');
    const projectId = input.project_id ?? null;
    if (p.project_id !== null && projectId !== p.project_id) throw new ApiError(403, 'forbidden', 'a project-scoped admin can only mint tokens for its own project');
    if (projectId) await this.orch.visibleProject(p, projectId);
    const token = newToken();
    await this.db.tx(async (c) => {
      await c.query('insert into api_tokens(token_hash, tenant_id, project_id, role, label) values ($1,$2,$3,$4,$5)', [tokenHash(token), p.tenant_id, projectId, input.role, input.label]);
      await this.orch.audit(c, p, 'token.create', input.label, { role: input.role, project_id: projectId });
    });
    return { token, label: input.label, role: input.role, project_id: projectId, note: 'shown once; stored only as a hash' };
  }

  async revokeToken(p: Principal, label: string) {
    requireRole(p, 'admin');
    const r = await this.db.query(`update api_tokens set revoked_at=now() where tenant_id=$1 and label=$2 and revoked_at is null and ($3::text is null or project_id=$3) returning label`, [p.tenant_id, label, p.project_id]);
    if (!r.rowCount) throw new ApiError(404, 'not_found', 'token not found');
    await this.orch.audit(this.db, p, 'token.revoke', label);
    return { revoked: r.rowCount };
  }

  async audit(p: Principal, limit = 100) {
    requireRole(p, 'admin');
    return (await this.db.query(`select actor, action, subject, detail, at from audit_log where tenant_id=$1 order by id desc limit $2`, [p.tenant_id, Math.min(limit, 1000)])).rows;
  }

  // ---------- runs for dashboards ----------

  async listRuns(p: Principal, limit = 50) {
    return (
      await this.db.query(
        `select r.id, r.project_id, r.environment, r.commit_sha, r.state, r.gate, r.reason, r.message, r.attempt, r.created_at, r.completed_at, d.provider_deployment_id, d.immutable_url
         from runs r join deployments d on d.id = r.deployment_id
         where r.tenant_id=$1 and ($2::text is null or r.project_id=$2) order by r.created_at desc limit $3`,
        [p.tenant_id, p.project_id, Math.min(limit, 500)],
      )
    ).rows;
  }

  /** Stream an artifact of a run the principal can see. */
  async artifact(p: Principal, runId: string, path: string): Promise<Buffer> {
    await this.orch.visibleRun(p, runId);
    const store = this.orch.deps.artifacts;
    if (!store) throw new ApiError(404, 'not_found', 'artifact storage is not configured');
    const row = await this.db.one<{ run_dir: string }>(`select run_dir from case_results where run_id=$1 and run_dir is not null and $2 like run_dir || '/%' limit 1`, [runId, path]);
    if (!row) throw new ApiError(404, 'not_found', 'artifact not found');
    const bytes = await store.get(path);
    if (!bytes) throw new ApiError(404, 'not_found', 'artifact not found');
    return bytes;
  }

  // ---------- baselines ----------

  /**
   * Approve a visual candidate from a run's evidence. The approval names the
   * reviewer and is tied to the run's deployment and commit; the candidate's
   * checksum must match the one recorded when it was captured.
   */
  async approveBaseline(p: Principal, runId: string, q: { scenario_id: string; execution_profile: string; checkpoint: string }) {
    requireRole(p, 'reviewer');
    const run = await this.orch.visibleRun(p, runId);
    const project = (await this.orch.projectById(run.project_id))!;
    const store = this.orch.deps.artifacts;
    const baselines = this.orch.deps.baselinesFor?.(project);
    if (!store || !baselines) throw new ApiError(409, 'not_configured', 'artifact and baseline storage must be configured');
    const row = await this.db.one<{ result: CaseResult; run_dir: string }>(
      `select result, run_dir from case_results where run_id=$1 and attempt=$2 and scenario_id=$3 and execution_profile=$4`,
      [runId, run.attempt, q.scenario_id, q.execution_profile],
    );
    if (!row) throw new ApiError(404, 'not_found', 'case not found in the latest attempt');
    const a = row.result.assertions.find((x) => x.type === 'visual_match' && (x.expected as { key?: BaselineKey })?.key?.checkpoint === q.checkpoint && (x.status === 'needs_review' || x.status === 'failed'));
    const key = (a?.expected as { key?: BaselineKey } | undefined)?.key;
    const m = a && /artifact: (\S+\.candidate\.png)#sha256=([0-9a-f]{64})/.exec(a.message ?? '');
    if (!a || !key || !m) throw new ApiError(404, 'not_found', 'no reviewable visual candidate for that checkpoint');
    const bytes = await store.get(`${row.run_dir}/${m[1]}`);
    if (!bytes) throw new ApiError(410, 'gone', 'candidate artifact is no longer retained');
    const dep = await this.db.one<{ provider_deployment_id: string }>('select provider_deployment_id from deployments where id=$1', [run.deployment_id]);
    const record = await baselines.approve(key, bytes, { approved_by: p.actor, commit_sha: run.commit_sha, deployment_id: dep?.provider_deployment_id ?? null, source: runId, expected_sha256: m[2]! });
    await this.db.tx(async (c) => {
      await c.query(
        `insert into baseline_approvals(tenant_id, project_id, run_id, scenario_id, checkpoint, execution_profile, rendering_profile, version, sha256, commit_sha, approved_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [run.tenant_id, run.project_id, runId, q.scenario_id, q.checkpoint, q.execution_profile, key.rendering_profile, record.version, record.sha256, run.commit_sha, p.actor],
      );
      await this.orch.audit(c, p, 'baseline.approve', runId, { ...q, version: record.version, sha256: record.sha256 });
    });
    return record;
  }

  // ---------- findings ----------

  async listFindings(p: Principal, projectId: string, status?: string) {
    await this.orch.visibleProject(p, projectId);
    return (await this.db.query(`select * from findings where project_id=$1 and ($2::text is null or status=$2) order by last_seen desc limit 500`, [projectId, status ?? null])).rows;
  }

  async getFinding(p: Principal, id: string) {
    const f = await this.db.one<{ project_id: string; tenant_id: string }>('select * from findings where id=$1', [id]);
    if (!f || f.tenant_id !== p.tenant_id || (p.project_id && p.project_id !== f.project_id)) throw new ApiError(404, 'not_found', 'finding not found');
    return f;
  }

  async reviewFinding(p: Principal, id: string, status: 'open' | 'accepted' | 'dismissed', note: string) {
    requireRole(p, 'reviewer');
    await this.getFinding(p, id);
    if (status === 'dismissed' && !note.trim()) throw new ApiError(400, 'note_required', 'dismissing a finding requires a note');
    await this.db.tx(async (c) => {
      await c.query('update findings set status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 where id=$1', [id, status, p.actor, note]);
      await this.orch.audit(c, p, 'finding.review', id, { status, note });
    });
    return this.getFinding(p, id);
  }

  // ---------- scenarios ----------

  /** Approve a proposed scenario into the project's suite (changes the suite revision). */
  async approveScenario(p: Principal, projectId: string, scenarioId: string) {
    requireRole(p, 'reviewer');
    const project = await this.orch.visibleProject(p, projectId);
    const cfg = project.config;
    const at = (x: string) => (isAbsolute(x) ? x : resolve(this.orch.deps.suiteBaseDir, x));
    if (!cfg.suite.coverage_file) throw new ApiError(409, 'not_configured', 'scenario proposals need a coverage graph');
    const suite = await loadSuite(cfg, this.orch.deps.suiteBaseDir);
    const graph = await loadCoverageGraph(at(cfg.suite.coverage_file));
    let r;
    try {
      r = await approveProposalFile(at(cfg.suite.specs_dir), scenarioId, p.actor, { graph, catalog: suite.catalog, policy: suite.policy });
    } catch (e) {
      throw new ApiError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 422, 'proposal_rejected', (e as Error).message);
    }
    await this.db.tx(async (c) => {
      await c.query('insert into scenario_approvals(tenant_id, project_id, scenario_id, source, sha256, approved_by) values ($1,$2,$3,$4,$5,$6)', [project.tenant_id, project.id, scenarioId, r.source, r.sha256, p.actor]);
      await this.orch.audit(c, p, 'scenario.approve', scenarioId, { project: project.id, sha256: r.sha256, source: r.source });
    });
    return { scenario_id: scenarioId, sha256: r.sha256, note: 'suite revision changed; results from earlier revisions no longer satisfy the gate' };
  }
}
