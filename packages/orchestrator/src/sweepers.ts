import { FixtureClient } from '@qa/oracles';
import type { Orchestrator } from './service.ts';

export interface SweepReport {
  cleaned: number;
  failed: number;
  alerted: number;
  purged_runs: number;
  purged_files: number;
}

/**
 * Durable housekeeping: retries fixture cleanups left pending by crashed or
 * failed attempts (alerting after repeated failure), and purges run artifacts
 * past each project's retention period. Both are idempotent.
 */
export class Sweeper {
  constructor(
    private readonly orch: Orchestrator,
    private readonly o: { env?: NodeJS.ProcessEnv; alertAfter?: number; staleMinutes?: number; alert?: (msg: string) => void } = {},
  ) {}

  async cleanup(): Promise<Pick<SweepReport, 'cleaned' | 'failed' | 'alerted'>> {
    const env = this.o.env ?? process.env;
    const tasks = (
      await this.orch.db.query<{ id: string; tenant_id: string; project_id: string; fixture_id: string; fixture_api_url: string; attempts: number; alerted_at: Date | null; run_id: string | null }>(
        `select t.id::text, t.tenant_id, t.project_id, t.fixture_id, t.fixture_api_url, t.attempts, t.alerted_at, t.run_id from cleanup_tasks t left join runs r on r.id = t.run_id
         where t.state='pending' and t.available_at <= now()
           and (r.id is null or r.state in ('COMPLETED','ERROR','CANCELLED','SUPERSEDED') or t.created_at < now() - make_interval(mins => $1))
         order by t.id limit 100`,
        [this.o.staleMinutes ?? 60],
      )
    ).rows;
    let cleaned = 0;
    let failed = 0;
    let alerted = 0;
    for (const t of tasks) {
      const project = await this.orch.projectById(t.project_id);
      const token = project ? env[project.config.fixture_api.token_env] : undefined;
      try {
        if (!token) throw new Error('fixture token unavailable');
        await new FixtureClient(t.fixture_api_url, token).cleanup(t.fixture_id);
        await this.orch.db.query(`update cleanup_tasks set state='done', attempts=attempts+1, last_error=null where id=$1`, [t.id]);
        await this.orch.audit(this.orch.db, { tenant_id: t.tenant_id, actor: 'sweeper' }, 'cleanup.done', t.fixture_id, { run_id: t.run_id });
        cleaned++;
      } catch (e) {
        failed++;
        const attempts = t.attempts + 1;
        const delay = Math.min(3600, 30 * 2 ** attempts);
        await this.orch.db.query(`update cleanup_tasks set attempts=$2, last_error=$3, available_at=now() + make_interval(secs => $4) where id=$1`, [t.id, attempts, (e as Error).message, delay]);
        if (attempts >= (this.o.alertAfter ?? 3) && !t.alerted_at) {
          await this.orch.db.query('update cleanup_tasks set alerted_at=now() where id=$1', [t.id]);
          await this.orch.audit(this.orch.db, { tenant_id: t.tenant_id, actor: 'sweeper' }, 'cleanup.alert', t.fixture_id, { attempts, error: (e as Error).message });
          (this.o.alert ?? console.error)(`ALERT cleanup of fixture ${t.fixture_id} (project ${t.project_id}) failed ${attempts} times: ${(e as Error).message}`);
          alerted++;
        }
      }
    }
    return { cleaned, failed, alerted };
  }

  async retention(now = new Date()): Promise<Pick<SweepReport, 'purged_runs' | 'purged_files'>> {
    const store = this.orch.deps.artifacts;
    if (!store) return { purged_runs: 0, purged_files: 0 };
    const runs = (
      await this.orch.db.query<{ id: string; tenant_id: string; project_id: string; config: { retention?: { artifacts_days?: number } } }>(
        `select r.id, r.tenant_id, r.project_id, p.config from runs r join projects p on p.id = r.project_id
         where r.artifacts_purged_at is null and r.completed_at is not null
           and r.completed_at < $1::timestamptz - make_interval(days => coalesce((p.config->'retention'->>'artifacts_days')::int, 30))`,
        [now.toISOString()],
      )
    ).rows;
    let files = 0;
    for (const r of runs) {
      const dirs = (await this.orch.db.query<{ run_dir: string }>('select distinct run_dir from case_results where run_id=$1 and run_dir is not null', [r.id])).rows;
      for (const d of dirs) files += await store.deletePrefix(d.run_dir);
      await this.orch.db.query('update runs set artifacts_purged_at=now() where id=$1', [r.id]);
      await this.orch.audit(this.orch.db, { tenant_id: r.tenant_id, actor: 'sweeper' }, 'retention.purge', r.id, { files });
    }
    return { purged_runs: runs.length, purged_files: files };
  }

  async runOnce(now?: Date): Promise<SweepReport> {
    return { ...(await this.cleanup()), ...(await this.retention(now)) };
  }
}
