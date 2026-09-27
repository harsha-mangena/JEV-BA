import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { buildApi } from '@qa/api';
import { Db } from '@qa/db';
import { bootstrapProject, depsFromEnv, JobWorker, Orchestrator, type Role } from '@qa/orchestrator';
import { CalibrationRegistry, withCalibration } from '@qa/calibration';
import { HEURISTIC_GATE_V0 } from '@qa/gate';
import { HttpS1Provider, probeRequest, TypeSafeProvider, validateResponse, type SystemOneProvider } from '@qa/s1';

export interface ServiceArgs {
  [k: string]: string | string[] | boolean | undefined;
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`${name} is required`);
  return v;
}

export class UsageError extends Error {}

const dbFromEnv = () => new Db(need(process.env.DATABASE_URL, 'DATABASE_URL'));

export async function migrate(): Promise<number> {
  const db = dbFromEnv();
  try {
    const ran = await db.migrate();
    console.log(ran.length ? `applied: ${ran.join(', ')}` : 'schema up to date');
    return 0;
  } finally {
    await db.close();
  }
}

export async function bootstrap(a: ServiceArgs): Promise<number> {
  const db = dbFromEnv();
  try {
    const path = need(a.config as string, '--config');
    const text = await readFile(path, 'utf8');
    const config = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    const tokens = ((a.token as string[] | undefined) ?? []).map((t) => {
      const [role, label] = t.split(':');
      if (!['admin', 'submitter', 'reviewer', 'viewer'].includes(role ?? '') || !label) throw new UsageError(`--token must be role:label, got ${t}`);
      return { role: role as Role, label };
    });
    const out = await bootstrapProject(db, {
      tenant: { id: need(a.tenant as string, '--tenant') },
      project: {
        id: need(a.project as string, '--project'),
        config,
        ...(a['repository-id'] ? { repository_id: a['repository-id'] as string } : {}),
        ...(a.repository ? { repository_full_name: a.repository as string } : {}),
        ...(a['webhook-secret-env'] ? { webhook_secret_ref: a['webhook-secret-env'] as string } : {}),
        ...(a['installation-id'] ? { github_installation_id: Number(a['installation-id']) } : {}),
      },
      tokens,
    });
    for (const [label, token] of Object.entries(out)) console.log(`${label}\t${token}`);
    if (Object.keys(out).length) console.error('Tokens are shown once and stored only as hashes.');
    return 0;
  } finally {
    await db.close();
  }
}

export async function serveApi(a: ServiceArgs): Promise<number> {
  const db = dbFromEnv();
  await db.migrate();
  const orch = new Orchestrator(depsFromEnv(db));
  const { registerServiceRoutes } = await import('@qa/api');
  const app = await buildApi(orch, { logger: true, extend: registerServiceRoutes });
  await app.listen({ port: Number(a.port ?? process.env.PORT ?? 8080), host: (a.host as string) ?? '0.0.0.0' });
  await new Promise<void>((resolve) => process.once('SIGTERM', () => resolve()));
  await app.close();
  await db.close();
  return 0;
}

export async function serveWorker(a: ServiceArgs): Promise<number> {
  const db = dbFromEnv();
  const orch = new Orchestrator(depsFromEnv(db));
  const exploration = await explorationFromEnv();
  const worker = new JobWorker(orch, { outDir: (a.out as string) ?? '.qa-runs', log: (m) => console.log(m), ...(exploration ? { exploration } : {}) });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => worker.stop());
  await worker.run();
  await db.close();
  return 0;
}

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = need(process.env.QA_API_TOKEN, 'QA_API_TOKEN');
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : null,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Submit a deployment candidate. Success means "accepted", never "QA passed". */
export async function submit(a: ServiceArgs): Promise<number> {
  const base = need(a['api-url'] as string, '--api-url').replace(/\/$/, '');
  let body: Record<string, unknown>;
  if (a['github-event']) {
    const ev = JSON.parse(await readFile(a['github-event'] as string, 'utf8'));
    body = {
      schema_version: 1,
      provider: 'github',
      repository_id: ev.repository.id,
      deployment_id: String(ev.deployment.id),
      deployment_status_id: String(ev.deployment_status.id),
      environment: ev.deployment.environment,
      commit_sha: ev.deployment.sha,
      candidate_url: ev.deployment_status.environment_url ?? null,
      ci_run_id: process.env.GITHUB_RUN_ID,
    };
  } else {
    body = {
      schema_version: 1,
      provider: (a.provider as string) ?? 'pipeline',
      ...(a.project ? { project_id: a.project } : {}),
      deployment_id: need(a['deployment-id'] as string, '--deployment-id'),
      environment: need(a.environment as string, '--environment'),
      commit_sha: need(a['commit-sha'] as string, '--commit-sha'),
      candidate_url: need(a['candidate-url'] as string, '--candidate-url'),
      ...(process.env.GITHUB_RUN_ID ? { ci_run_id: process.env.GITHUB_RUN_ID } : {}),
    };
  }
  const r = await api('POST', `${base}/v1/deployment-events`, body);
  if (r.status !== 200 && r.status !== 202) {
    console.error(`submission rejected (${r.status}): ${JSON.stringify(r.json)}`);
    return 2;
  }
  console.log(`accepted run ${String(r.json.run_id)}${r.json.deduplicated ? ' (deduplicated)' : ''} — this is not a QA result`);
  console.log(String(r.json.run_id));
  return 0;
}

/** Wait for a run to finish. Exit 0 only for a completed run with an eligible gate. */
export async function wait(a: ServiceArgs): Promise<number> {
  const base = need(a['api-url'] as string, '--api-url').replace(/\/$/, '');
  const id = need(a['run-id'] as string, '--run-id');
  const deadline = Date.now() + Number(a.timeout ?? 1800) * 1000;
  for (;;) {
    const r = await api('GET', `${base}/v1/runs/${encodeURIComponent(id)}`);
    if (r.status !== 200) {
      console.error(`cannot read run (${r.status}): ${JSON.stringify(r.json)}`);
      return 2;
    }
    const run = r.json.run as { state: string; gate: { eligible: boolean; reasons: string[] } | null; message: string | null };
    if (['COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED'].includes(run.state)) {
      console.log(`${run.state}: ${run.message ?? ''}`);
      for (const reason of run.gate?.reasons ?? []) console.log(`  - ${reason}`);
      return run.state === 'COMPLETED' && run.gate?.eligible ? 0 : 1;
    }
    if (Date.now() > deadline) {
      console.error(`timed out waiting; run is ${run.state}`);
      return 1;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/** S1 provider from environment: QA_S1_PROVIDER=typesafe|http, QA_S1_ENDPOINT, QA_S1_API_KEY, QA_S1_MODEL. */
export function s1FromEnv(): { provider: SystemOneProvider; model: string } | null {
  const kind = process.env.QA_S1_PROVIDER;
  if (!kind) return null;
  const endpoint = need(process.env.QA_S1_ENDPOINT, 'QA_S1_ENDPOINT');
  const model = need(process.env.QA_S1_MODEL, 'QA_S1_MODEL');
  if (kind === 'typesafe') return { provider: new TypeSafeProvider({ endpoint, apiKey: need(process.env.QA_S1_API_KEY, 'QA_S1_API_KEY') }), model };
  if (kind === 'http') return { provider: new HttpS1Provider('http', { endpoint, ...(process.env.QA_S1_API_KEY ? { apiKey: process.env.QA_S1_API_KEY } : {}) }), model };
  throw new UsageError(`unknown QA_S1_PROVIDER ${kind}`);
}

async function explorationFromEnv() {
  const s1 = s1FromEnv();
  if (!s1) return null;
  const cal = process.env.QA_CALIBRATION_DIR ? await new CalibrationRegistry(process.env.QA_CALIBRATION_DIR).current() : null;
  return { s1: s1.provider, model: s1.model, gate: withCalibration(HEURISTIC_GATE_V0, cal) };
}

/** Send a tiny request and validate the response strictly — run before enabling autonomy. */
export async function s1Probe(): Promise<number> {
  const s1 = s1FromEnv();
  if (!s1) throw new UsageError('set QA_S1_PROVIDER, QA_S1_ENDPOINT, QA_S1_MODEL (and QA_S1_API_KEY)');
  const req = probeRequest(s1.model);
  const started = Date.now();
  const raw = await s1.provider.ask(req);
  const v = validateResponse(req, raw);
  console.log(JSON.stringify({ provider: s1.provider.id, resolved_model: v.resolvedModel, elapsed_ms: Date.now() - started, valid_heads: Object.keys(v.answers), invalid_heads: v.invalid, op: v.answers.op?.distribution ?? null }, null, 2));
  if (Object.keys(v.invalid).length) {
    console.error('Contract mismatch: fix the adapter mapping before enabling autonomy.');
    return 1;
  }
  return 0;
}
