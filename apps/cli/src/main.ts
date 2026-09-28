#!/usr/bin/env -S npx tsx
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ContractError,
  ExecutionProfileId,
  loadFixtureCatalog,
  loadPolicy,
  loadValidatedScenario,
  type CaseResult,
  type Scenario,
} from '@qa/contracts';
import { parseDefectList, startFixtureApp } from '@qa/fixture-test-app';
import { FixtureClient } from '@qa/oracles';
import { runSuite } from '@qa/worker';
import * as svc from './service.ts';
import * as baselineCmd from './baselines.ts';
import * as coverageCmd from './coverage.ts';
import * as compileCmd from './compile.ts';
import * as evalsCmd from './evals.ts';
import { FindingLedger, FsBaselineStore } from '@qa/quality';

const USAGE = `Usage: qa <command> [options]

Commands:
  validate                 Validate every scenario against the fixture catalog and project policy.
  run                      Run approved regression scenarios against a deployed target.
  demo                     Start the fixture app in-process (optionally with seeded defects) and run the suite.

Visual baselines:
  baseline pending         List visual checkpoints awaiting approval in a run (--run <run dir>).
  baseline approve         Approve every pending candidate in a run (--run --approver --commit-sha [--baselines dir]).
  baseline list            List approved baselines (--baselines dir).

Change impact and proposals:
  select                   Selection manifest for --base..--head in --repo (default .) using specs/coverage.yaml.
  coverage learn           Learn observed scenario→route edges from run evidence (--run <dir>...).
  coverage transitions     Declared vs observed route transitions (--run <dir>...).
  coverage boundaries      What an exploration covered (--run <dir>).
  proposals generate       Propose boundary/negative scenarios from input equivalence classes.
  proposals validate <id>  Validate a proposal's oracles and references.
  proposals approve <id>   Promote a valid proposal into specs/scenarios (--approver).

Regression compilation and repairs:
  compile                  Compile a passed exploration case into a proposal + Playwright export (--run --scenario).
  repair propose           Propose a locator repair from a step_target_unavailable failure (--run --scenario).
  repair apply             Validate and apply a repair (--config <repair.json> --approver); semantic changes are refused.

Calibration (Phase 8):
  evals extract            Export S1 decision records for labeling (--run <dir>... --app <id> --decision-config <file> [--labels out]).
  calibrate                Fit, select threshold, evaluate on grouped splits (--labels <jsonl> --target 0.99 [--registry dir]).
  evals canary             Check a candidate configuration's labeled replay against the current calibration (--labels).
  qualify                  Qualify a calibration for one profile (--calibration <version.json> --evidence <json>
                           --project --environment --application --qualifications <dir>); exit 0 only if qualified.
                           Qualification expires with its live compatibility evidence.
  qualification revoke     Revoke a qualification now (--qualifications <dir> --id <qualification id> --by --reason).
  qualification renew      Extend a qualification with a current live probe of the same model
                           (--qualifications <dir> --id <qualification id> --evidence <provider_compat json>).

Service commands (need DATABASE_URL):
  migrate                  Apply database migrations.
  bootstrap                Create/update a tenant and project; mint tokens (--tenant --project --config
                           [--repository-id --repository --webhook-secret-env --installation-id] [--token role:label]...)
  serve-api                Run the control API (--port).
  serve-worker             Run a job worker (--out). Both servers refuse to start when a startup check fails.
  doctor                   Run the startup checks for --role api|worker and exit non-zero on any failure.

System One:
  s1 probe                 Validate the live provider contract (QA_S1_PROVIDER, QA_S1_ENDPOINT, QA_S1_MODEL, QA_S1_API_KEY).

Client commands (need QA_API_TOKEN):
  submit                   Submit a deployment candidate (--api-url, then --github-event <file> or
                           --deployment-id --environment --commit-sha --candidate-url [--provider --project]).
  wait                     Wait for a run (--api-url --run-id [--timeout s]); exit 0 only if the gate is eligible.
  promote                  Decide and consume a single-use promotion (--api-url --project --environment
                           --deployment-id --commit-sha); exit 0 only if promoted.

Common options:
  --specs <dir>            Specs directory (default: ./specs)
  --policy <file>          Project policy (default: <specs>/policies/fixture-shop.yaml)
  --scenario <id>          Restrict to a scenario (repeatable)
  --profile <id>           Restrict to an execution profile (repeatable)
  --out <dir>              Output directory for run evidence (default: ./.qa-runs)
  --retries <n>            Extra attempts after a non-PASS; failures are preserved as FLAKY (default: 0)
  --concurrency <n>        Parallel browser contexts (default: 2)

run options:
  --base-url <url>         Immutable URL of the deployment under test (required)
  --environment <name>     Environment name checked against scenario policy (required)
  --commit-sha <sha>       Expected deployed revision; execution is blocked on mismatch
  --deployment-id <id>     Deployment identifier recorded in the report
  --fixture-api <url>      Fixture service URL (default: --base-url)
  --signed-out-path <p>    Path the app redirects to without a session (default: /login)
  QA_FIXTURE_TOKEN         Environment variable holding the fixture-service token (required)

demo options:
  --defects <a,b>          Seeded defects to enable (see docs/defect-catalog.md)

Exit codes: 0 gate eligible, 1 gate held, 2 usage or contract error.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    specs: { type: 'string', default: 'specs' },
    policy: { type: 'string' },
    scenario: { type: 'string', multiple: true },
    profile: { type: 'string', multiple: true },
    out: { type: 'string', default: '.qa-runs' },
    retries: { type: 'string', default: '0' },
    concurrency: { type: 'string', default: '2' },
    'base-url': { type: 'string' },
    environment: { type: 'string' },
    'commit-sha': { type: 'string' },
    'deployment-id': { type: 'string' },
    'fixture-api': { type: 'string' },
    'signed-out-path': { type: 'string', default: '/login' },
    defects: { type: 'string' },
    baselines: { type: 'string', default: 'baselines' },
    approver: { type: 'string' },
    run: { type: 'string', multiple: true },
    base: { type: 'string' },
    labels: { type: 'string' },
    target: { type: 'string' },
    registry: { type: 'string', default: 'evals/registry' },
    app: { type: 'string' },
    'decision-config': { type: 'string' },
    head: { type: 'string' },
    repo: { type: 'string' },
    tenant: { type: 'string' },
    project: { type: 'string' },
    config: { type: 'string' },
    'repository-id': { type: 'string' },
    repository: { type: 'string' },
    'webhook-secret-env': { type: 'string' },
    'installation-id': { type: 'string' },
    token: { type: 'string', multiple: true },
    port: { type: 'string' },
    host: { type: 'string' },
    'api-url': { type: 'string' },
    'github-event': { type: 'string' },
    provider: { type: 'string' },
    'candidate-url': { type: 'string' },
    'run-id': { type: 'string' },
    role: { type: 'string' },
    calibration: { type: 'string' },
    evidence: { type: 'string' },
    application: { type: 'string' },
    qualifications: { type: 'string' },
    id: { type: 'string' },
    by: { type: 'string' },
    reason: { type: 'string' },
    timeout: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function int(name: string, v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}

async function loadSpecs(): Promise<{ scenarios: Scenario[]; policy: Awaited<ReturnType<typeof loadPolicy>> }> {
  const specs = resolve(values.specs!);
  const policy = await loadPolicy(values.policy ? resolve(values.policy) : join(specs, 'policies/fixture-shop.yaml'));
  const catalog = await loadFixtureCatalog(join(specs, 'fixtures.yaml'));
  const dir = join(specs, 'scenarios');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
  const scenarios = await Promise.all(files.map((f) => loadValidatedScenario(join(dir, f), catalog, policy)));
  const wanted = values.scenario;
  if (wanted) {
    const unknown = wanted.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) fail(`unknown scenario(s): ${unknown.join(', ')}`);
    return { scenarios: scenarios.filter((s) => wanted.includes(s.id)), policy };
  }
  return { scenarios, policy };
}

function profiles(): ExecutionProfileId[] | undefined {
  return values.profile?.map((p) => {
    const r = ExecutionProfileId.safeParse(p);
    return r.success ? r.data : fail(`unknown profile ${p}; expected one of ${ExecutionProfileId.options.join(', ')}`);
  });
}

const line = (c: CaseResult) =>
  `${c.verdict.padEnd(9)} ${`${c.scenario_id} [${c.execution_profile}]`.padEnd(58)} ${c.reason ?? ''}${c.message ? ` — ${c.message}` : ''}`;

async function execute(baseUrl: string, environment: string, fixtures: FixtureClient): Promise<number> {
  const { scenarios, policy } = await loadSpecs();
  const ac = new AbortController();
  process.once('SIGINT', () => {
    console.error('cancelling: finishing current steps and cleaning up fixtures…');
    ac.abort();
  });
  const p = profiles();
  const findings = await new FindingLedger(join(resolve(values.out!), 'findings.json')).load();
  const { report, runDir } = await runSuite({
    quality: { baselines: new FsBaselineStore(resolve(values.baselines!)), findings },
    scenarios,
    policy,
    baseUrl,
    environment,
    fixtures,
    outDir: resolve(values.out!),
    retries: int('retries', values.retries),
    concurrency: Math.max(1, int('concurrency', values.concurrency)),
    signedOutPath: values['signed-out-path']!,
    signal: ac.signal,
    onCase: (c) => console.log(line(c)),
    ...(p ? { profiles: p } : {}),
    ...(values['commit-sha'] ? { commitSha: values['commit-sha'] } : {}),
    ...(values['deployment-id'] ? { deploymentId: values['deployment-id'] } : {}),
  });
  if (report.cases.every((c) => c.attempt_id === 'none')) for (const c of report.cases) console.log(line(c));
  console.log(`\nGate: ${report.gate.eligible ? 'ELIGIBLE' : 'HELD'}`);
  for (const r of report.gate.reasons) console.log(`  - ${r}`);
  console.log(`Evidence: ${runDir}/report.html`);
  return report.gate.eligible ? 0 : 1;
}

async function main(): Promise<number> {
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 2;
  }
  switch (cmd) {
    case 'validate': {
      const { scenarios } = await loadSpecs();
      for (const s of scenarios) console.log(`ok  ${s.id}  (${s.milestones.length} milestones, ${s.milestones.reduce((n, m) => n + m.assertions.length, 0)} assertions, ${s.execution_profiles.join(', ')})`);
      return 0;
    }
    case 'run': {
      const baseUrl = values['base-url'] ?? fail('--base-url is required');
      const environment = values.environment ?? fail('--environment is required');
      const token = process.env.QA_FIXTURE_TOKEN ?? fail('QA_FIXTURE_TOKEN must be set');
      return execute(baseUrl, environment, new FixtureClient(values['fixture-api'] ?? baseUrl, token));
    }
    case 'demo': {
      const token = randomBytes(24).toString('base64url');
      const app = await startFixtureApp({ fixtureToken: token, defects: parseDefectList(values.defects) });
      console.log(`fixture app at ${app.url} (defects: ${[...app.defects].join(', ') || 'none'})\n`);
      try {
        return await execute(app.url, 'local', new FixtureClient(app.url, token));
      } finally {
        await app.close();
      }
    }
    case 'baseline': {
      const sub = positionals[1];
      if (sub === 'pending') return baselineCmd.pending(values);
      if (sub === 'approve') return baselineCmd.approve(values);
      if (sub === 'list') return baselineCmd.list(values);
      fail('usage: qa baseline pending|approve|list --run <run dir> [--baselines dir] [--approver name --commit-sha sha]');
    }
    case 'select':
      return coverageCmd.select(values);
    case 'coverage':
      return coverageCmd.coverage(positionals[1], values);
    case 'proposals':
      return coverageCmd.proposals(positionals[1], positionals[2], values);
    case 'compile':
      return compileCmd.compile(values);
    case 'repair':
      return compileCmd.repair(positionals[1], values);
    case 'evals':
      return evalsCmd.evals(positionals[1], values);
    case 'calibrate':
      return evalsCmd.calibrateCmd(values);
    case 'qualify':
      return evalsCmd.qualifyCmd(values);
    case 'qualification':
      return evalsCmd.qualificationCmd(positionals[1], values);
    case 's1':
      if (positionals[1] === 'probe') return svc.s1Probe();
      fail('usage: qa s1 probe');
    case 'migrate':
      return svc.migrate();
    case 'bootstrap':
      return svc.bootstrap(values);
    case 'doctor':
      return svc.doctor(values);
    case 'serve-api':
      return svc.serveApi(values);
    case 'serve-worker':
      return svc.serveWorker(values);
    case 'submit':
      return svc.submit(values);
    case 'wait':
      return svc.wait(values);
    case 'promote':
      return svc.promote(values);
    default:
      fail(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ContractError) fail(`contract error: ${e.message}`);
    if (e instanceof svc.UsageError) fail(e.message);
    console.error(e);
    process.exit(2);
  },
);
