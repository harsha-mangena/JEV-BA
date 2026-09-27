import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { launchBrowser } from '@qa/browser';
import { combineAttempts, evaluateReleaseGate, type CaseResult, type ExecutionProfileId, type ProjectPolicy, type RunReport, type Scenario } from '@qa/contracts';
import { toHtml, toJUnit } from '@qa/evidence';
import type { FixtureClient } from '@qa/oracles';
import { runCaseAttempt } from './case.ts';
import type { ExplorationOptions } from './exploration.ts';
import type { AttemptHooks } from './session.ts';

export interface SuiteOptions {
  scenarios: Scenario[];
  policy: ProjectPolicy;
  baseUrl: string;
  environment: string;
  fixtures: FixtureClient;
  outDir: string;
  /** Expected deployed revision. When set, execution is blocked unless the target reports exactly this SHA. */
  commitSha?: string;
  deploymentId?: string;
  /** Restrict to these profiles; defaults to each scenario's declared profiles. */
  profiles?: ExecutionProfileId[];
  /** Additional attempts after a non-PASS, each with a fresh fixture. Failures are preserved (FLAKY). */
  retries?: number;
  concurrency?: number;
  signedOutPath?: string;
  signal?: AbortSignal;
  browser?: Browser;
  runId?: string;
  onCase?: (c: CaseResult) => void;
  /** Enables exploration scenarios (S1-guided). Their results are advisory unless explicitly required. */
  exploration?: ExplorationOptions;
  /** Restrict execution to these cases (sharding). Defaults to every scenario × profile. */
  cases?: Array<{ scenario_id: string; execution_profile: ExecutionProfileId }>;
  hooks?: AttemptHooks;
}

export interface SuiteResult {
  report: RunReport;
  runDir: string;
}

interface PlannedCase {
  scenario: Scenario;
  profile: ExecutionProfileId;
}

function stubCase(p: PlannedCase, verdict: CaseResult['verdict'], reason: CaseResult['reason'], message: string): CaseResult {
  const now = new Date().toISOString();
  return {
    scenario_id: p.scenario.id,
    requirement_ids: p.scenario.requirement_ids,
    execution_profile: p.profile,
    attempt_id: 'none',
    critical: p.scenario.critical,
    verdict,
    reason,
    message,
    started_at: now,
    finished_at: now,
    milestones_completed: [],
    assertions: p.scenario.milestones.flatMap((m) => m.assertions.map((a, index) => ({ milestone_id: m.id, index, type: a.type, status: 'not_run' as const, elapsed_ms: 0 }))),
    artifacts: [],
    cleanup: { status: 'skipped', detail: 'not executed' },
    prior_attempts: [],
  };
}

async function reportedRevision(fixtures: FixtureClient): Promise<string | null> {
  try {
    return (await fixtures.version()).commit_sha;
  } catch {
    return null;
  }
}

/**
 * Run every (scenario, profile) case once (plus retries), then evaluate the
 * release gate over the complete expected set. The deployed revision is
 * checked before and after execution; a mismatch blocks, and drift during the
 * run supersedes every result rather than attributing it to the wrong commit.
 */
export async function runSuite(o: SuiteOptions): Promise<SuiteResult> {
  const runId = o.runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;
  const runDir = join(o.outDir, runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();

  const planned: PlannedCase[] = o.scenarios
    .flatMap((scenario) => scenario.execution_profiles.filter((p) => !o.profiles || o.profiles.includes(p)).map((profile) => ({ scenario, profile })))
    .filter((p) => !o.cases || o.cases.some((c) => c.scenario_id === p.scenario.id && c.execution_profile === p.profile));
  const expected = planned.map((p) => ({ scenario_id: p.scenario.id, execution_profile: p.profile }));
  let cases: CaseResult[] = [];

  const before = o.commitSha ? await reportedRevision(o.fixtures) : null;
  if (o.commitSha && before !== o.commitSha) {
    const why = before === null ? 'target revision could not be verified' : `target reports ${before}, expected ${o.commitSha}`;
    cases = planned.map((p) => stubCase(p, 'BLOCKED', 'version_drift', why));
  } else {
    const browser = o.browser ?? (await launchBrowser());
    try {
      const queue = [...planned];
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (o.signal?.aborted) {
            cases.push(stubCase(next, 'CANCELLED', 'cancelled', 'run cancelled before this case started'));
            continue;
          }
          const attempts: CaseResult[] = [];
          for (let n = 1; n <= 1 + (o.retries ?? 0); n++) {
            const r = await runCaseAttempt({ browser, scenario: next.scenario, profile: next.profile, baseUrl: o.baseUrl, environment: o.environment, policy: o.policy, fixtures: o.fixtures, runDir, attemptNumber: n, ...(o.signedOutPath ? { signedOutPath: o.signedOutPath } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.exploration ? { exploration: o.exploration } : {}), ...(o.hooks ? { hooks: o.hooks } : {}) });
            attempts.push(r);
            if (r.verdict === 'PASS' || r.verdict === 'BLOCKED' || r.verdict === 'CANCELLED') break;
          }
          const last = attempts[attempts.length - 1]!;
          const combined: CaseResult = {
            ...last,
            verdict: combineAttempts(attempts.map((a) => a.verdict)),
            prior_attempts: attempts.slice(0, -1).map((a) => ({ attempt_id: a.attempt_id, verdict: a.verdict, reason: a.reason, message: a.message })),
          };
          if (combined.verdict === 'FLAKY' && combined.reason === null) {
            const first = attempts.find((a) => a.verdict !== 'PASS')!;
            combined.reason = first.reason;
            combined.message = `passed on attempt ${attempts.length} after: ${first.message ?? first.verdict}`;
          }
          cases.push(combined);
          o.onCase?.(combined);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, worker));
    } finally {
      if (!o.browser) await browser.close();
    }
    if (o.commitSha) {
      const after = await reportedRevision(o.fixtures);
      if (after !== o.commitSha) {
        cases = cases.map((c) => ({ ...c, verdict: 'SUPERSEDED', reason: 'version_drift', message: `target revision changed during the run (now ${after ?? 'unknown'})` }));
      }
    }
  }

  const order = new Map(expected.map((e, i) => [`${e.scenario_id}@${e.execution_profile}`, i]));
  cases.sort((a, b) => order.get(`${a.scenario_id}@${a.execution_profile}`)! - order.get(`${b.scenario_id}@${b.execution_profile}`)!);
  // Exploration results are advisory: they are reported but neither required nor able to satisfy the gate.
  const exploratory = new Set(o.scenarios.filter((sc) => sc.mode === 'exploration').map((sc) => sc.id));
  const gate = evaluateReleaseGate(
    expected.filter((e) => !exploratory.has(e.scenario_id)),
    cases
      .filter((c) => !exploratory.has(c.scenario_id))
      .map((c) => ({ scenario_id: c.scenario_id, execution_profile: c.execution_profile, verdict: c.verdict, critical: c.critical, required: true })),
  );
  const cleanupFailures = cases.filter((c) => c.cleanup.status === 'failed');
  if (cleanupFailures.length) gate.reasons.push(...cleanupFailures.map((c) => `${c.scenario_id}@${c.execution_profile}: cleanup failed (${c.cleanup.detail ?? ''})`));

  const report: RunReport = {
    schema_version: 1,
    run_id: runId,
    base_url: o.baseUrl,
    environment: o.environment,
    commit_sha: o.commitSha ?? null,
    deployment_id: o.deploymentId ?? null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    cases,
    gate: { eligible: gate.eligible && cleanupFailures.length === 0, reasons: gate.reasons },
  };
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runDir, 'junit.xml'), toJUnit(report));
  await writeFile(join(runDir, 'report.html'), toHtml(report));
  return { report, runDir };
}
