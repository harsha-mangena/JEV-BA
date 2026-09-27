import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { describeStep, EXECUTION_PROFILES, executeStep } from '@qa/browser';
import {
  authorizeIntent,
  parseRef,
  resolveAllowedOrigins,
  type AssertionResult,
  type CaseResult,
  type ExecutionProfileId,
  type ProjectPolicy,
  type ProvisionedFixture,
  type ReasonCode,
  type RiskClass,
  type Scenario,
  type Step,
  type Verdict,
} from '@qa/contracts';
import { EvidenceLog } from '@qa/evidence';
import { captureBaseline, evaluateAssertion, type FixtureClient } from '@qa/oracles';

export interface CaseOptions {
  browser: Browser;
  scenario: Scenario;
  profile: ExecutionProfileId;
  baseUrl: string;
  environment: string;
  policy: ProjectPolicy;
  fixtures: FixtureClient;
  runDir: string;
  attemptNumber: number;
  /** Path the app redirects to when a session is missing; detects expired/invalid auth fixtures. */
  signedOutPath?: string;
  signal?: AbortSignal;
}

class Stop extends Error {
  constructor(
    readonly verdict: Verdict,
    readonly reason: ReasonCode,
    message: string,
  ) {
    super(message);
  }
}

const usesSecrets = (s: Scenario) =>
  s.milestones.some((m) => m.steps.some((st) => st.op === 'type' && st.value_ref !== undefined && parseRef(st.value_ref).scope === 'secret'));

function riskOf(step: Step, mutation: string | undefined): RiskClass {
  if (mutation) return 'test_owned_mutation';
  if (step.op === 'navigate' || step.op === 'reload') return 'read_only';
  if (step.op === 'type' || step.op === 'select') return 'reversible_input';
  return 'unknown';
}

/**
 * Execute one attempt of one scenario under one execution profile with a
 * fresh, test-owned fixture. The verdict is decided only by the approved
 * assertions; any path that does not run every assertion to success is
 * non-PASS.
 */
export async function runCaseAttempt(o: CaseOptions): Promise<CaseResult> {
  const { scenario: s, profile } = o;
  const attemptId = `${s.id}.${profile}.a${o.attemptNumber}.${randomBytes(3).toString('hex')}`;
  const caseDir = join(o.runDir, 'cases', s.id, profile, attemptId);
  const log = new EvidenceLog(caseDir, attemptId, o.runDir);
  await log.init();
  const started = new Date();
  const deadline = started.getTime() + s.budgets.max_wall_clock_seconds * 1000;
  const assertions: AssertionResult[] = [];
  const completed: string[] = [];
  const consoleErrors: string[] = [];
  let verdict: Verdict = 'ERROR';
  let reason: ReasonCode | null = 'infrastructure_error';
  let message: string | null = 'case did not complete';
  let fixture: ProvisionedFixture | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let tracing = false;
  let blockedNavigation: string | null = null;
  let cleanup: CaseResult['cleanup'] = { status: s.cleanup === 'none' ? 'skipped' : 'pending' };

  log.record('run_started', `${s.id} on ${profile}`, { scenario: s.id, profile, base_url: o.baseUrl, environment: o.environment, attempt: o.attemptNumber });

  let milestoneIndex = 0;
  try {
    if (!s.policy.environments.includes(o.environment)) throw new Stop('BLOCKED', 'policy_denied', `scenario is not permitted in environment ${o.environment}`);
    if (s.mode !== 'regression') throw new Stop('BLOCKED', 'unsupported_capability', 'exploration scenarios require the S1-guided runner');

    try {
      fixture = await o.fixtures.provision(s.fixture);
    } catch (e) {
      throw new Stop('ERROR', 'fixture_error', `fixture ${s.fixture}: ${(e as Error).message}`);
    }
    for (const v of Object.values(fixture.secrets)) log.redactor.register(v);
    for (const c of fixture.auth?.cookies ?? []) log.redactor.register(c.value);
    log.record('fixture_provisioned', `fixture ${fixture.name}`, { fixture_id: fixture.fixture_id, fields: Object.keys(fixture.data), signed_in: !!fixture.auth });

    const owner = fixture.data.customer_id;
    const baseline = await captureBaseline(o.fixtures, owner === undefined ? [] : [String(owner)]).catch((e: Error) => {
      throw new Stop('ERROR', 'fixture_error', `baseline read failed: ${e.message}`);
    });

    const candidateOrigin = new URL(o.baseUrl).origin;
    const allowed = resolveAllowedOrigins(o.policy, s.policy.allowed_origin_profile, candidateOrigin);
    context = await o.browser.newContext({ ...EXECUTION_PROFILES[profile], baseURL: o.baseUrl });
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:' || allowed.has(url.origin)) return route.continue();
      log.record('network_blocked', `blocked request to ${url.origin}`, { url: `${url.origin}${url.pathname}`, navigation: req.isNavigationRequest() });
      if (req.isNavigationRequest() && req.frame() === page?.mainFrame()) blockedNavigation = url.origin;
      return route.abort('blockedbyclient');
    });
    if (fixture.auth) await context.addCookies(fixture.auth.cookies.map((c) => ({ ...c, url: o.baseUrl })));

    if (usesSecrets(s)) {
      log.record('policy', 'trace capture disabled: scenario types secret values', {});
    } else {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    }

    page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('framenavigated', (f) => {
      if (f === page?.mainFrame()) log.record('navigation', `navigated to ${new URL(f.url()).pathname}`, { path: new URL(f.url()).pathname });
    });

    const resolveValue = (ref: string) => {
      const { scope, field } = parseRef(ref);
      const v = scope === 'secret' ? fixture!.secrets[field] : fixture!.data[field];
      if (v === undefined) throw new Stop('ERROR', 'fixture_error', `${ref} was not provisioned`);
      return String(v);
    };

    const response = await page.goto(s.start_path, { waitUntil: 'load', timeout: s.budgets.action_timeout_ms * 2 });
    if (blockedNavigation) throw new Stop('BLOCKED', 'origin_blocked', `start page navigated to disallowed origin ${blockedNavigation}`);
    if (fixture.auth && o.signedOutPath && new URL(page.url()).pathname === o.signedOutPath) {
      throw new Stop('BLOCKED', 'auth_unavailable', `supplied session was not accepted: redirected to ${o.signedOutPath}`);
    }
    if (response && response.status() >= 500) throw new Stop('FAIL', 'step_failed', `start page returned HTTP ${response.status()}`);

    let actions = 0;
    for (; milestoneIndex < s.milestones.length; milestoneIndex++) {
      const m = s.milestones[milestoneIndex]!;
      for (const step of m.steps) {
        if (o.signal?.aborted) throw new Stop('CANCELLED', 'cancelled', 'run cancelled');
        if (Date.now() > deadline) throw new Stop('ERROR', 'deadline_exceeded', `exceeded ${s.budgets.max_wall_clock_seconds}s wall-clock budget`);
        if (++actions > s.budgets.max_actions) throw new Stop('BLOCKED', 'budget_exhausted', `exceeded ${s.budgets.max_actions} actions`);

        const auth = authorizeIntent(o.policy, s.policy.mutations, o.environment, step.intent);
        const intentId = `${attemptId}.i${actions}`;
        const intent = {
          intent_id: intentId,
          operation: step.op,
          description: describeStep(step),
          parameter_ref: step.op === 'type' ? (step.value_ref ?? null) : step.op === 'select' ? (step.option_ref ?? null) : null,
          action_intent: step.intent ?? null,
          risk_class: riskOf(step, auth.allowed ? auth.mutation : undefined),
        };
        if (!auth.allowed) {
          log.record('intent', `denied: ${intent.description}`, { ...intent, state: 'denied', policy_decision: 'denied', reason: auth.reason });
          throw new Stop('BLOCKED', 'policy_denied', auth.reason);
        }
        log.record('intent', `persisted: ${intent.description}`, { ...intent, state: 'persisted', policy_decision: 'allowed' });
        const outcome = await executeStep(step, { page, baseUrl: o.baseUrl, timeoutMs: s.budgets.action_timeout_ms, resolveValue });
        log.record('intent', `${outcome.status}: ${intent.description}`, { intent_id: intentId, state: outcome.status === 'done' ? 'acknowledged' : outcome.status === 'not_dispatched' ? 'failed' : 'effect_unknown', detail: outcome.detail });
        if (blockedNavigation) throw new Stop('BLOCKED', 'origin_blocked', `navigation to disallowed origin ${blockedNavigation}`);
        if (outcome.status === 'not_dispatched') throw new Stop('FAIL', outcome.reason, `${m.id}: ${intent.description}: ${outcome.detail}`);
        if (outcome.status === 'effect_unknown') {
          throw new Stop('ERROR', outcome.reason, `${m.id}: ${intent.description}: input may have been dispatched; effect unknown and not retried (${outcome.detail})`);
        }
      }

      let failed = 0;
      for (const [ai, a] of m.assertions.entries()) {
        const t0 = Date.now();
        let r: Omit<AssertionResult, 'milestone_id' | 'index' | 'elapsed_ms'>;
        try {
          r = await evaluateAssertion(a, { page, fixtureData: fixture.data, fixtures: o.fixtures, baseline, consoleErrors, timeoutMs: s.budgets.assertion_timeout_ms });
        } catch (e) {
          r = { type: a.type, status: 'failed', message: `assertion could not be evaluated: ${(e as Error).message}` };
        }
        const result: AssertionResult = { milestone_id: m.id, index: ai, elapsed_ms: Date.now() - t0, ...r };
        assertions.push(result);
        log.record('assertion', `${m.id}#${ai} ${a.type}: ${result.status}`, { ...result });
        if (result.status !== 'passed') failed++;
      }
      const shot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (shot) await log.writeArtifact('screenshot', `${String(milestoneIndex).padStart(2, '0')}-${m.id}.png`, shot);
      if (failed > 0) {
        throw new Stop('FAIL', 'assertion_failed', `${m.id}: ${failed} of ${m.assertions.length} assertion(s) failed`);
      }
      completed.push(m.id);
      log.record('milestone', `milestone ${m.id} verified`, { milestone: m.id });
    }

    const passedCount = assertions.filter((a) => a.status === 'passed').length;
    if (passedCount === 0 || assertions.some((a) => a.status !== 'passed')) throw new Stop('ERROR', 'no_assertions_executed', 'no approved assertion ran to success');
    verdict = 'PASS';
    reason = null;
    message = null;
  } catch (e) {
    if (e instanceof Stop) {
      verdict = e.verdict;
      reason = e.reason;
      message = e.message;
    } else {
      verdict = 'ERROR';
      reason = 'infrastructure_error';
      message = (e as Error).message.split('\n')[0] ?? String(e);
    }
    // Any milestone we never reached is visibly not run, never silently absent.
    const reported = new Set(assertions.map((a) => `${a.milestone_id}#${a.index}`));
    s.milestones.forEach((m, mi) =>
      m.assertions.forEach((a, ai) => {
        if (!reported.has(`${m.id}#${ai}`) && mi >= milestoneIndex) assertions.push({ milestone_id: m.id, index: ai, type: a.type, status: 'not_run', elapsed_ms: 0 });
      }),
    );
  } finally {
    if (page && verdict !== 'PASS') {
      const shot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (shot) await log.writeArtifact('screenshot', 'failure.png', shot).catch(() => undefined);
    }
    if (context && tracing) {
      const tracePath = join(caseDir, 'trace.zip');
      await context.tracing
        .stop({ path: tracePath })
        .then(async () => log.registerArtifact('trace', tracePath, await readFile(tracePath)))
        .catch((e: Error) => log.record('artifact', `trace capture failed: ${e.message}`));
    }
    await context?.close().catch(() => undefined);
    if (fixture && s.cleanup === 'delete_test_owned_entities') {
      try {
        const removed = await o.fixtures.cleanup(fixture.fixture_id);
        cleanup = { status: 'done', detail: `${removed} test-owned entities removed` };
      } catch (e) {
        cleanup = { status: 'failed', detail: (e as Error).message };
      }
      log.record('cleanup', `cleanup ${cleanup.status}`, { fixture_id: fixture.fixture_id, ...cleanup });
    } else if (!fixture && cleanup.status === 'pending') {
      cleanup = { status: 'skipped', detail: 'no fixture was provisioned' };
    }
    log.record('case_finished', `${verdict}${reason ? ` (${reason})` : ''}`, { verdict, reason, message });
    await log.flush();
  }

  const events = await log.checksumFile('events', log.eventsFile);
  return {
    scenario_id: s.id,
    requirement_ids: s.requirement_ids,
    execution_profile: profile,
    attempt_id: attemptId,
    critical: s.critical,
    verdict,
    reason,
    message: message === null ? null : log.redactor.string(message),
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    milestones_completed: completed,
    assertions: assertions.sort((a, b) => s.milestones.findIndex((m) => m.id === a.milestone_id) - s.milestones.findIndex((m) => m.id === b.milestone_id) || a.index - b.index),
    artifacts: [...log.artifacts, events],
    cleanup,
    prior_attempts: [],
  };
}
