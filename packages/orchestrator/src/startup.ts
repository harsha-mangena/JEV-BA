import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@qa/db';
import { loadSuite } from './suite.ts';
import type { Orchestrator } from './service.ts';

export interface StartupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface StartupOptions {
  role: 'api' | 'worker';
  env: NodeJS.ProcessEnv;
  /** Worker only: prove a browser can be launched (injected so this package needs no browser dependency). */
  launchBrowser?: () => Promise<{ close(): Promise<void> }>;
  /** Worker only: a live S1 probe when autonomy may act (injected by the CLI). */
  probeS1?: () => Promise<{ ok: boolean; detail: string }>;
}

const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');

/**
 * Fail-fast configuration validation for a service process. Every problem is
 * reported at once; a process with a failing check must not start, because a
 * misconfiguration would otherwise surface later as a misleading verdict.
 */
export async function checkStartup(db: Db, orch: Orchestrator, o: StartupOptions): Promise<StartupCheck[]> {
  const checks: StartupCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const env = o.env;

  try {
    await db.query('select 1');
    add('database', true, 'reachable');
  } catch (e) {
    add('database', false, (e as Error).message);
    return checks;
  }
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.query<{ name: string }>('select name from schema_migrations').catch(() => ({ rows: [] as Array<{ name: string }> }))).rows.map((r) => r.name));
  const missing = files.filter((f) => !applied.has(f));
  add('migrations', missing.length === 0, missing.length ? `not applied: ${missing.join(', ')} (run qa migrate)` : `${files.length} applied`);
  if (missing.length) return checks;

  const projects = (await db.query<{ id: string }>('select id from projects order by id')).rows;
  add('projects', true, `${projects.length} configured`);
  for (const { id } of projects) {
    const p = await orch.projectById(id).catch((e: Error) => e);
    if (p instanceof Error || !p) {
      add(`project:${id}:config`, false, p instanceof Error ? p.message : 'not found');
      continue;
    }
    const suite = await loadSuite(p.config, orch.deps.suiteBaseDir).catch((e: Error) => e);
    add(`project:${id}:suite`, !(suite instanceof Error), suite instanceof Error ? suite.message : `${suite.scenarios.length} scenarios, ${suite.revision}`);
    if (o.role === 'worker') {
      const readOnlyOnly = Object.values(p.config.environments).every((e) => e.read_only === true);
      const tok = env[p.config.fixture_api.token_env];
      add(`project:${id}:fixture_token`, readOnlyOnly || !!tok, tok ? `${p.config.fixture_api.token_env} set` : readOnlyOnly ? 'read-only environments only' : `${p.config.fixture_api.token_env} is not set`);
    }
    if (o.role === 'api' && p.webhook_secret_ref) add(`project:${id}:webhook_secret`, !!env[p.webhook_secret_ref], env[p.webhook_secret_ref] ? `${p.webhook_secret_ref} set` : `${p.webhook_secret_ref} is not set`);
  }

  const mode = env.QA_AUTONOMY_MODE ?? 'shadow';
  add('autonomy_mode', ['shadow', 'heuristic_staging', 'calibrated'].includes(mode), mode);
  if (o.role === 'worker') {
    if (o.launchBrowser) {
      const b = await o.launchBrowser().then(
        async (x) => (await x.close(), null),
        (e: Error) => e.message.split('\n')[0]!,
      );
      add('browser', b === null, b ?? 'chromium launches');
    }
    if (env.QA_S1_PROVIDER) {
      if (mode === 'shadow') add('s1_probe', true, 'shadow mode: decisions are recorded, never executed');
      else if (!o.probeS1) add('s1_probe', false, 'autonomy can act but no provider probe is configured');
      else {
        const r = await o.probeS1().catch((e: Error) => ({ ok: false, detail: e.message }));
        add('s1_probe', r.ok, r.detail);
      }
    }
  }
  if (env.QA_METRICS_TOKEN !== undefined) add('metrics_token', env.QA_METRICS_TOKEN.length >= 16, env.QA_METRICS_TOKEN.length >= 16 ? 'configured' : 'QA_METRICS_TOKEN must be at least 16 characters');
  return checks;
}

/** Prometheus text exposition of the service's durable state. */
export async function metricsText(db: Db): Promise<string> {
  const lines: string[] = [];
  const gauge = (name: string, help: string, rows: Array<{ labels: Record<string, string>; value: number }>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const r of rows) {
      const l = Object.entries(r.labels).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`).join(',');
      lines.push(`${name}${l ? `{${l}}` : ''} ${r.value}`);
    }
  };
  const q = async (sql: string) => (await db.query<{ k: string; n: string }>(sql)).rows.map((r) => ({ k: r.k, n: Number(r.n) }));
  gauge('qa_runs', 'Runs by state.', (await q(`select state k, count(*) n from runs group by state`)).map((r) => ({ labels: { state: r.k }, value: r.n })));
  gauge('qa_jobs', 'Jobs by kind and state.', (await db.query<{ kind: string; state: string; n: string }>(`select kind, state, count(*) n from jobs group by kind, state`)).rows.map((r) => ({ labels: { kind: r.kind, state: r.state }, value: Number(r.n) })));
  gauge('qa_jobs_expired_leases', 'Leased jobs whose lease has expired (worker loss).', (await q(`select 'x' k, count(*) n from jobs where state='leased' and lease_expires_at < now()`)).map((r) => ({ labels: {}, value: r.n })));
  gauge('qa_outbox_pending', 'Status events not yet published.', (await q(`select 'x' k, count(*) n from outbox_events where published_at is null`)).map((r) => ({ labels: {}, value: r.n })));
  gauge('qa_cleanup_pending', 'Fixture cleanup obligations not yet satisfied.', (await q(`select state k, count(*) n from cleanup_tasks group by state`)).map((r) => ({ labels: { state: r.k }, value: r.n })));
  gauge('qa_intents', 'Action intents by state (NEEDS_REVIEW requires a human).', (await q(`select state k, count(*) n from action_intents group by state`)).map((r) => ({ labels: { state: r.k }, value: r.n })));
  gauge('qa_promotions', 'Promotion decisions by outcome.', (await q(`select coalesce(consume_outcome, case when eligible then 'eligible_unconsumed' else 'held_unconsumed' end) k, count(*) n from promotion_decisions group by 1`)).map((r) => ({ labels: { outcome: r.k }, value: r.n })));
  gauge('qa_findings_open', 'Open quality findings.', (await q(`select 'x' k, count(*) n from findings where status='open'`)).map((r) => ({ labels: {}, value: r.n })));
  return `${lines.join('\n')}\n`;
}
