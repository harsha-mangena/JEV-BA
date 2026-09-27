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

const USAGE = `Usage: qa <command> [options]

Commands:
  validate                 Validate every scenario against the fixture catalog and project policy.
  run                      Run approved regression scenarios against a deployed target.
  demo                     Start the fixture app in-process (optionally with seeded defects) and run the suite.

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
  const { report, runDir } = await runSuite({
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
    default:
      fail(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ContractError) fail(`contract error: ${e.message}`);
    console.error(e);
    process.exit(2);
  },
);
