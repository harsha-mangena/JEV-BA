#!/usr/bin/env node
// Unattended deployment flow against the compose stack, recorded as evidence:
//   1. a clean deployment is tested, its gate opens and it is promoted once;
//   2. a defective deployment is tested, its gate is held and promotion is refused
//      (and the older clean decision can no longer promote either);
//   3. a worker container is SIGKILLed mid-checkout; a replacement recovers the
//      shard (lease expiry, fencing, intent reconciliation) and the run completes.
// Usage: node deploy/demo/run-demo.mjs [--keep] [--out docs/evidence/phase10]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/evidence/phase10';
const ENV_FILE = 'deploy/demo/demo.env';
const env = Object.fromEntries(
  (await import('node:fs')).readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const API = `http://127.0.0.1:${env.QA_API_PORT}`;
const CLEAN_SHA = 'a'.repeat(40);
const DEFECTIVE_SHA = 'b'.repeat(40);
const evidence = { started_at: new Date().toISOString(), steps: [] };
const log = (m) => console.log(`[demo] ${m}`);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const compose = (...a) => sh('docker', ['compose', '--env-file', ENV_FILE, ...a]);
const psql = (sql) => compose('exec', '-T', 'postgres', 'psql', '-U', 'qa', '-d', 'qa', '-At', '-F', '\t', '-c', sql).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, token, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function until(what, fn, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
const terminal = (s) => ['COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED'].includes(s);
async function deploy(tokens, id, sha, url) {
  const r = await http('POST', '/v1/deployment-events', tokens.ci, { schema_version: 1, provider: 'pipeline', project_id: 'shop', deployment_id: id, environment: 'staging', commit_sha: sha, candidate_url: url, ci_run_id: 1 });
  if (r.status !== 202) throw new Error(`deployment ${id} not accepted: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.run_id;
}
async function waitRun(tokens, runId) {
  return until(`run ${runId}`, async () => {
    const r = await http('GET', `/v1/runs/${runId}`, tokens.viewer);
    return terminal(r.json.run?.state) ? r.json : null;
  });
}
async function promote(tokens, deploymentId, sha) {
  const d = await http('POST', '/v1/promotions', tokens.ci, { project_id: 'shop', environment: 'staging', deployment_id: deploymentId, commit_sha: sha });
  const c = d.json.decision_id ? await http('POST', `/v1/promotions/${d.json.decision_id}/consume`, tokens.ci, {}) : null;
  return { decision: d.json, consume: c?.json ?? null };
}
const summary = (r) => ({ run_id: r.run.id, state: r.run.state, gate: r.run.gate, generation: r.run.generation, suite_revision: r.run.suite_revision, cases: r.cases.map((c) => `${c.scenario_id}@${c.execution_profile}: ${c.verdict}`) });

try {
  log('starting stack');
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', '--wait', 'postgres', 'fixture-clean', 'fixture-defective');
  compose('up', '-d', 'migrate', 'api');
  await until('api health', async () => (await fetch(`${API}/healthz`).then((r) => r.ok, () => false)));

  log('bootstrapping tenant, project and tokens');
  const boot = compose('run', '--rm', '--no-deps', 'api', 'bootstrap', '--tenant', 'demo', '--project', 'shop', '--config', 'deploy/demo/project.yaml', '--token', 'submitter:ci', '--token', 'viewer:viewer', '--token', 'admin:admin');
  const tokens = Object.fromEntries(boot.split('\n').filter((l) => l.includes('\t')).map((l) => l.split('\t')));
  compose('up', '-d', 'worker');
  await until('worker startup checks', async () => /ok\s+browser|FAIL/.test(compose('logs', 'worker')), 120_000);
  evidence.worker_startup_checks = compose('logs', '--no-log-prefix', 'worker').split('\n').filter((l) => /^(ok  |FAIL) /.test(l));

  log('1. clean deployment');
  const cleanRun = await deploy(tokens, 'clean-1', CLEAN_SHA, 'http://fixture-clean:4310');
  const clean = await waitRun(tokens, cleanRun);
  const cleanPromotion = await promote(tokens, 'clean-1', CLEAN_SHA);
  const replay = cleanPromotion.decision.decision_id ? await http('POST', `/v1/promotions/${cleanPromotion.decision.decision_id}/consume`, tokens.ci, {}) : null;
  evidence.steps.push({ step: 'clean deployment', run: summary(clean), promotion: cleanPromotion, second_consume_status: replay?.status ?? null });
  if (clean.run.state !== 'COMPLETED' || !clean.run.gate?.eligible || !cleanPromotion.consume?.promoted || replay?.status !== 409) throw new Error('clean deployment did not pass, promote once and refuse a replay');

  log('2. defective deployment');
  const staleDecision = await http('POST', '/v1/promotions', tokens.ci, { project_id: 'shop', environment: 'staging', deployment_id: 'clean-1', commit_sha: CLEAN_SHA });
  const defectiveRun = await deploy(tokens, 'defective-1', DEFECTIVE_SHA, 'http://fixture-defective:4311');
  const defective = await waitRun(tokens, defectiveRun);
  const defectivePromotion = await promote(tokens, 'defective-1', DEFECTIVE_SHA);
  const stale = await http('POST', `/v1/promotions/${staleDecision.json.decision_id}/consume`, tokens.ci, {});
  evidence.steps.push({ step: 'defective deployment', run: summary(defective), promotion: defectivePromotion, earlier_clean_decision_consumed_after_new_deployment: stale.json });
  if (defective.run.state !== 'COMPLETED' || defective.run.gate?.eligible || defectivePromotion.consume?.promoted || stale.json.promoted) throw new Error('defective deployment was not held, or a stale decision promoted');

  log('3. worker crash mid-checkout and recovery');
  const crashRun = await deploy(tokens, 'clean-2', CLEAN_SHA, 'http://fixture-clean:4310');
  const inflight = await until('a checkout intent in DISPATCHING', async () => psql(`select intent_id from action_intents where run_id='${crashRun}' and contract_intent='checkout.submit' and state='DISPATCHING' limit 1`) || null, 180_000);
  const workerId = compose('ps', '-q', 'worker').trim();
  sh('docker', ['kill', '--signal', 'KILL', workerId]);
  const killedAt = new Date().toISOString();
  const atKill = psql(`select state from action_intents where intent_id='${inflight}'`);
  compose('rm', '-f', 'worker');
  compose('up', '-d', 'worker');
  const recovered = await waitRun(tokens, crashRun);
  const transitions = psql(`select coalesce(from_state,'-'), to_state, fence from intent_transitions where intent_id='${inflight}' order by id`).split('\n').map((l) => l.split('\t'));
  const receipts = psql(`select kind, entity_id from effect_receipts where intent_id='${inflight}'`);
  const jobs = psql(`select kind, state, attempts, fence from jobs where run_id='${crashRun}' order by id`).split('\n').map((l) => l.split('\t'));
  const crashPromotion = await promote(tokens, 'clean-2', CLEAN_SHA);
  // The dead worker's fixtures are cleaned by the durable cleanup obligations (sweeper).
  await until('orphaned fixtures swept', async () => psql(`select count(*) from cleanup_tasks where state<>'done'`) === '0', 120_000);
  const review = psql(`select intent_id, scenario_id, contract_intent, detail from action_intents where state='NEEDS_REVIEW'`);
  evidence.steps.push({ step: 'worker SIGKILL mid-checkout', killed_at: killedAt, intent: inflight, intent_state_at_kill: atKill, transitions, receipts, jobs, run: summary(recovered), promotion: crashPromotion, cleanup_after_recovery: 'all obligations done', intents_needing_review: review ? review.split('\n') : [] });
  if (recovered.run.state !== 'COMPLETED' || !recovered.run.gate?.eligible || !transitions.some((t) => t[1] === 'RECONCILED')) throw new Error('the crashed run did not recover with a reconciled intent');

  const metrics = await fetch(`${API}/metrics`, { headers: { authorization: `Bearer ${env.QA_METRICS_TOKEN}` } }).then((r) => r.text());
  evidence.metrics = metrics.split('\n').filter((l) => l && !l.startsWith('#'));
  evidence.result = 'PASSED';
  log('all steps passed');
} catch (e) {
  evidence.result = 'FAILED';
  evidence.error = e.message;
  evidence.logs_tail = (() => {
    try {
      return compose('logs', '--tail', '80', 'worker', 'api').split('\n');
    } catch {
      return [];
    }
  })();
  console.error(`[demo] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  evidence.image = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', env.QA_IMAGE ?? 'jev-ba/qa:local']).trim();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'demo-flow.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  log(`evidence → ${join(out, 'demo-flow.json')}`);
  if (!keep) compose('down', '-v', '--remove-orphans');
}
