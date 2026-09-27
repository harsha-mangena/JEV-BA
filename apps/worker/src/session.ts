import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { EXECUTION_PROFILES } from '@qa/browser';
import {
  parseRef,
  resolveAllowedOrigins,
  type AssertionResult,
  type CaseResult,
  type ExecutionProfileId,
  type Milestone,
  type ProjectPolicy,
  type ProvisionedFixture,
  type ReasonCode,
  type Scenario,
  type Verdict,
} from '@qa/contracts';
import { EvidenceLog } from '@qa/evidence';
import { captureBaseline, evaluateAssertion, type EntityBaseline, type FixtureClient } from '@qa/oracles';

export interface AttemptOptions {
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
  /** Durable cleanup obligations: called as soon as a fixture exists, and when cleanup settles. */
  hooks?: AttemptHooks;
}

export interface AttemptHooks {
  fixtureProvisioned?(fixtureId: string): Promise<void>;
  cleanupSettled?(fixtureId: string, ok: boolean, detail: string): Promise<void>;
}

/** Thrown by drivers to end an attempt with an explicit, non-PASS classification. */
export class Stop extends Error {
  constructor(
    readonly verdict: Verdict,
    readonly reason: ReasonCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  readonly o: AttemptOptions;
  readonly attemptId: string;
  readonly page: Page;
  readonly log: EvidenceLog;
  readonly fixture: ProvisionedFixture;
  readonly baseline: EntityBaseline;
  readonly consoleErrors: string[];
  readonly completed: string[];
  readonly deadline: number;
  resolveValue(ref: string): string;
  /** Throws Stop if navigation left the allowed origins, the run was cancelled, or the deadline passed. */
  checkpoint(): void;
  /** Evaluate a milestone's approved assertions; records and returns failures. */
  verify(m: Milestone): Promise<AssertionResult[]>;
  screenshot(name: string): Promise<void>;
}

export type Driver = (s: Session) => Promise<void>;

const usesSecrets = (s: Scenario) =>
  s.inputs.some((r) => parseRef(r).scope === 'secret') ||
  s.milestones.some((m) => m.steps.some((st) => st.op === 'type' && st.value_ref !== undefined && parseRef(st.value_ref).scope === 'secret'));

/**
 * Shared lifecycle for one attempt: fixture provisioning, isolated context,
 * origin allow-list, auth, evidence, verification and cleanup. The driver
 * decides how milestones are pursued; only approved assertions decide PASS.
 */
export async function runAttempt(o: AttemptOptions, drive: Driver): Promise<CaseResult> {
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
  let shotCount = 0;

  log.record('run_started', `${s.id} on ${profile}`, { scenario: s.id, mode: s.mode, profile, base_url: o.baseUrl, environment: o.environment, attempt: o.attemptNumber });

  try {
    if (!s.policy.environments.includes(o.environment)) throw new Stop('BLOCKED', 'policy_denied', `scenario is not permitted in environment ${o.environment}`);

    try {
      fixture = await o.fixtures.provision(s.fixture);
    } catch (e) {
      throw new Stop('ERROR', 'fixture_error', `fixture ${s.fixture}: ${(e as Error).message}`);
    }
    await o.hooks?.fixtureProvisioned?.(fixture.fixture_id);
    for (const v of Object.values(fixture.secrets)) log.redactor.register(v);
    for (const c of fixture.auth?.cookies ?? []) log.redactor.register(c.value);
    log.record('fixture_provisioned', `fixture ${fixture.name}`, { fixture_id: fixture.fixture_id, fields: Object.keys(fixture.data), signed_in: !!fixture.auth });

    const owner = fixture.data.customer_id;
    const baseline = await captureBaseline(o.fixtures, owner === undefined ? [] : [String(owner)]).catch((e: Error) => {
      throw new Stop('ERROR', 'fixture_error', `baseline read failed: ${e.message}`);
    });

    const allowed = resolveAllowedOrigins(o.policy, s.policy.allowed_origin_profile, new URL(o.baseUrl).origin);
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

    if (usesSecrets(s)) log.record('policy', 'trace capture disabled: scenario types secret values', {});
    else {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    }

    const p = await context.newPage();
    page = p;
    p.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    p.on('pageerror', (e) => consoleErrors.push(e.message));
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) log.record('navigation', `navigated to ${new URL(f.url()).pathname}`, { path: new URL(f.url()).pathname });
    });

    const fx = fixture;
    const session: Session = {
      o,
      attemptId,
      page: p,
      log,
      fixture: fx,
      baseline,
      consoleErrors,
      completed,
      deadline,
      resolveValue(ref) {
        const { scope, field } = parseRef(ref);
        const v = scope === 'secret' ? fx.secrets[field] : fx.data[field];
        if (v === undefined) throw new Stop('ERROR', 'fixture_error', `${ref} was not provisioned`);
        return String(v);
      },
      checkpoint() {
        if (blockedNavigation) throw new Stop('BLOCKED', 'origin_blocked', `navigation to disallowed origin ${blockedNavigation}`);
        if (o.signal?.aborted) throw new Stop('CANCELLED', 'cancelled', 'run cancelled');
        if (Date.now() > deadline) throw new Stop('ERROR', 'deadline_exceeded', `exceeded ${s.budgets.max_wall_clock_seconds}s wall-clock budget`);
      },
      async verify(m) {
        const failed: AssertionResult[] = [];
        for (const [ai, a] of m.assertions.entries()) {
          const t0 = Date.now();
          let r: Omit<AssertionResult, 'milestone_id' | 'index' | 'elapsed_ms'>;
          try {
            r = await evaluateAssertion(a, { page: p, fixtureData: fx.data, fixtures: o.fixtures, baseline, consoleErrors, timeoutMs: s.budgets.assertion_timeout_ms });
          } catch (e) {
            r = { type: a.type, status: 'failed', message: `assertion could not be evaluated: ${(e as Error).message}` };
          }
          const result: AssertionResult = { milestone_id: m.id, index: ai, elapsed_ms: Date.now() - t0, ...r };
          assertions.push(result);
          log.record('assertion', `${m.id}#${ai} ${a.type}: ${result.status}`, { ...result });
          if (result.status !== 'passed') failed.push(result);
        }
        await session.screenshot(m.id);
        if (failed.length === 0) {
          completed.push(m.id);
          log.record('milestone', `milestone ${m.id} verified`, { milestone: m.id });
        }
        return failed;
      },
      async screenshot(name) {
        const shot = await p.screenshot({ fullPage: true }).catch(() => null);
        if (shot) await log.writeArtifact('screenshot', `${String(shotCount++).padStart(2, '0')}-${name}.png`, shot);
      },
    };

    const response = await p.goto(s.start_path, { waitUntil: 'load', timeout: s.budgets.action_timeout_ms * 2 });
    session.checkpoint();
    if (fixture.auth && o.signedOutPath && new URL(p.url()).pathname === o.signedOutPath) {
      throw new Stop('BLOCKED', 'auth_unavailable', `supplied session was not accepted: redirected to ${o.signedOutPath}`);
    }
    if (response && response.status() >= 500) throw new Stop('FAIL', 'step_failed', `start page returned HTTP ${response.status()}`);

    await drive(session);

    const expectedCount = s.milestones.reduce((n, m) => n + m.assertions.length, 0);
    const passed = assertions.filter((a) => a.status === 'passed').length;
    if (completed.length !== s.milestones.length || passed !== expectedCount || assertions.length !== expectedCount) {
      throw new Stop('ERROR', 'no_assertions_executed', `driver finished with ${completed.length}/${s.milestones.length} milestones and ${passed}/${expectedCount} assertions verified`);
    }
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
  } finally {
    // Every approved assertion is reported: anything not evaluated is visibly not_run.
    const reported = new Set(assertions.map((a) => `${a.milestone_id}#${a.index}`));
    for (const m of s.milestones) {
      m.assertions.forEach((a, ai) => {
        if (!reported.has(`${m.id}#${ai}`)) assertions.push({ milestone_id: m.id, index: ai, type: a.type, status: 'not_run', elapsed_ms: 0 });
      });
    }
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
      await o.hooks?.cleanupSettled?.(fixture.fixture_id, cleanup.status === 'done', cleanup.detail ?? '').catch((e: Error) => log.record('cleanup', `cleanup hook failed: ${e.message}`));
    } else if (!fixture && cleanup.status === 'pending') {
      cleanup = { status: 'skipped', detail: 'no fixture was provisioned' };
    }
    log.record('case_finished', `${verdict}${reason ? ` (${reason})` : ''}`, { verdict, reason, message });
    await log.flush();
  }

  const events = await log.checksumFile('events', log.eventsFile);
  const order = (id: string) => s.milestones.findIndex((m) => m.id === id);
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
    assertions: assertions.sort((a, b) => order(a.milestone_id) - order(b.milestone_id) || a.index - b.index),
    artifacts: [...log.artifacts, events],
    cleanup,
    prior_attempts: [],
  };
}
