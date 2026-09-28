import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { EXECUTION_PROFILES, safeScreenshot, type PrivacyOptions, type StepOutcome } from '@qa/browser';
import {
  authorizeAction,
  parseRef,
  type ActionRequest,
  type AuthorizationDecision,
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
import { captureBaseline, evaluateAssertion, type EffectReceipt, type EntityBaseline, type Evaluation, type FixtureClient } from '@qa/oracles';
import { MemoryIntentStore, reconcileIntent, type IntentState, type IntentStore, type Reconciliation } from './intents.ts';
import type { BaselineStore, FindingLedger, VisualReviewer } from '@qa/quality';

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
  quality?: QualityOptions;
  /** Read-only capability profile (production checks): nothing provisioned, only read-only actions permitted. */
  readOnly?: boolean;
  /** Durable intent store (the service passes a fenced PostgreSQL store); defaults to an in-process store. */
  intents?: IntentStore;
}

export interface QualityOptions {
  baselines: BaselineStore | null;
  findings?: FindingLedger;
  reviewer?: VisualReviewer;
  commitSha?: string | null;
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
  /** What every image captured in this attempt must mask (registered secrets and declared regions). */
  privacy(): PrivacyOptions;
  readonly o: AttemptOptions;
  readonly attemptId: string;
  readonly page: Page;
  readonly log: EvidenceLog;
  readonly fixture: ProvisionedFixture | null;
  readonly baseline: EntityBaseline;
  readonly consoleErrors: string[];
  readonly completed: string[];
  readonly deadline: number;
  /** Aborts on run cancellation or when the attempt deadline passes; pass it to every provider/adapter call. */
  readonly signal: AbortSignal;
  resolveValue(ref: string): string;
  /** Throws Stop if navigation left the allowed origins, the run was cancelled, or the deadline passed. */
  checkpoint(): void;
  /** Shared authorization service bound to this attempt's policy, scenario, environment, role and profile. */
  authorize(request: ActionRequest): AuthorizationDecision;
  /** Remaining attempt budget, capped at `cap` (never below 1 ms). */
  remainingMs(cap: number): number;
  /**
   * Record an authorized intent before dispatch, run `fn` exactly once, and
   * record the outcome. Durable storage and reconciliation plug in here.
   */
  dispatch(intent: DispatchIntent, fn: () => Promise<StepOutcome>): Promise<StepOutcome>;
  /** Evaluate a milestone's approved assertions; records and returns failures. */
  verify(m: Milestone): Promise<AssertionResult[]>;
  screenshot(name: string): Promise<void>;
}

export type Driver = (s: Session) => Promise<void>;

export interface DispatchIntent {
  intent_id: string;
  operation: string;
  description: string;
  route: string;
  control: unknown;
  parameter_ref: string | null;
  action_intent: string | null;
  effect: string;
  contract_intent: string | null;
  risk_class: string;
  mutation: string | null;
  milestone_id: string;
  step_index?: number;
  [k: string]: unknown;
}

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
  let owner: unknown;
  /** Idempotency header for the dispatch in progress (read by the context route handler). */
  let dispatchTag: { header: string; key: string } | null = null;
  const intents = o.intents ?? new MemoryIntentStore();
  /** What every captured image must mask: registered secrets (as they grow) and declared regions. */
  const privacy = (): PrivacyOptions => ({ secrets: log.redactor.values(), selectors: o.policy.privacy?.mask_selectors ?? [] });
  /** Acknowledged mutations the application cannot confirm by key; settled when this attempt ends under its live lease. */
  const awaitingSettlement: string[] = [];
  // One signal for the whole attempt: run cancellation or the wall-clock deadline aborts in-flight adapter calls.
  const attemptSignal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);

  log.record('run_started', `${s.id} on ${profile}`, { scenario: s.id, mode: s.mode, profile, base_url: o.baseUrl, environment: o.environment, attempt: o.attemptNumber });

  try {
    if (!s.policy.environments.includes(o.environment)) throw new Stop('BLOCKED', 'policy_denied', `scenario is not permitted in environment ${o.environment}`);

    if (o.readOnly && (s.fixture || s.policy.mutations.length)) throw new Stop('BLOCKED', 'policy_denied', 'read-only profile: scenarios may not provision fixtures or mutate');
    if (s.fixture) {
      try {
        fixture = await o.fixtures.provision(s.fixture, attemptSignal);
      } catch (e) {
        throw new Stop('ERROR', 'fixture_error', `fixture ${s.fixture}: ${(e as Error).message}`);
      }
      await o.hooks?.fixtureProvisioned?.(fixture.fixture_id);
      for (const v of Object.values(fixture.secrets)) log.redactor.register(v);
      for (const c of fixture.auth?.cookies ?? []) log.redactor.register(c.value);
      log.record('fixture_provisioned', `fixture ${fixture.name}`, { fixture_id: fixture.fixture_id, fields: Object.keys(fixture.data), signed_in: !!fixture.auth });
    }

    owner = fixture?.data.customer_id;
    const baseline = await captureBaseline(o.fixtures, owner === undefined ? [] : [String(owner)]).catch((e: Error) => {
      throw new Stop('ERROR', 'fixture_error', `baseline read failed: ${e.message}`);
    });

    const allowed = resolveAllowedOrigins(o.policy, s.policy.allowed_origin_profile, new URL(o.baseUrl).origin);
    context = await o.browser.newContext({ ...EXECUTION_PROFILES[profile].options, baseURL: o.baseUrl });
    const baseOrigin = new URL(o.baseUrl).origin;
    // The only route handler: origin allow-list, plus the idempotency key of the dispatch in progress
    // on its state-changing same-origin requests (a second, per-dispatch handler could race with it).
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:' || allowed.has(url.origin)) {
        const tag = dispatchTag;
        if (tag && req.method() !== 'GET' && url.origin === baseOrigin) return route.continue({ headers: { ...req.headers(), [tag.header]: tag.key } });
        return route.continue();
      }
      log.record('network_blocked', `blocked request to ${url.origin}`, { url: `${url.origin}${url.pathname}`, navigation: req.isNavigationRequest() });
      if (req.isNavigationRequest() && req.frame() === page?.mainFrame()) blockedNavigation = url.origin;
      return route.abort('blockedbyclient');
    });
    if (fixture?.auth) await context.addCookies(fixture.auth.cookies.map((c) => ({ ...c, url: o.baseUrl })));

    if (usesSecrets(s)) log.record('policy', 'trace capture disabled: scenario types secret values', {});
    else {
      // No screencast frames: pixels cannot be sanitized after the fact (DOM snapshots are text and are).
      await context.tracing.start({ screenshots: false, snapshots: true });
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

    const fx = fixture ?? null;
    const session: Session = {
      privacy,
      o,
      attemptId,
      page: p,
      log,
      fixture: fx,
      baseline,
      consoleErrors,
      completed,
      deadline,
      signal: attemptSignal,
      resolveValue(ref) {
        const { scope, field } = parseRef(ref);
        if (!fx) throw new Stop('ERROR', 'fixture_error', `${ref} requested but the scenario has no fixture`);
        const v = scope === 'secret' ? fx.secrets[field] : fx.data[field];
        if (v === undefined) throw new Stop('ERROR', 'fixture_error', `${ref} was not provisioned`);
        return String(v);
      },
      authorize(request) {
        return authorizeAction({ policy: o.policy, scenario: s.policy, environment: o.environment, role: s.role, readOnly: !!o.readOnly }, request);
      },
      remainingMs(cap) {
        return Math.max(1, Math.min(cap, deadline - Date.now()));
      },
      async dispatch(intent, fn) {
        const adapter = o.fixtures;
        const keyed = intent.mutation !== null && intent.contract_intent !== null && adapter.capabilities.keyed_intents.includes(intent.contract_intent);
        const key = keyed ? intent.intent_id : null;
        const move = async (to: IntentState, detail: string | null = null, receipts: EffectReceipt[] = []) => {
          await intents.transition(intent.intent_id, to, detail, receipts).catch((e: Error) => {
            throw new Stop('ERROR', 'infrastructure_error', `intent ${intent.intent_id} could not be recorded (${to}): ${e.message}`);
          });
          log.record('intent_transition', `${intent.intent_id} → ${to}`, { intent_id: intent.intent_id, state: to, detail, receipts: receipts.map((r) => r.entity_id) });
        };
        // Durable before any input: a worker that dies from here on leaves a record recovery can resolve.
        await intents
          .prepare({ intent_id: intent.intent_id, attempt_id: attemptId, scenario_id: s.id, execution_profile: profile, owner: owner === undefined ? null : String(owner), idempotency_key: key, effect: intent.effect, mutation: intent.mutation, contract_intent: intent.contract_intent, data: intent })
          .catch((e: Error) => {
            throw new Stop('ERROR', 'infrastructure_error', `intent could not be persisted; nothing was dispatched: ${e.message}`);
          });
        log.record('intent', `persisted: ${intent.description}`, { ...intent, idempotency_key: key, state: 'persisted', policy_decision: 'allowed' });
        await move('DISPATCHING');
        // The idempotency key travels only on this dispatch's state-changing same-origin requests.
        const header = adapter.capabilities.idempotency_header;
        dispatchTag = key && header ? { header, key } : null;
        let outcome: StepOutcome;
        try {
          outcome = await fn();
        } finally {
          dispatchTag = null;
        }
        log.record('intent', `${outcome.status}: ${intent.description}`, { intent_id: intent.intent_id, state: outcome.status === 'done' ? 'acknowledged' : outcome.status === 'not_dispatched' ? 'failed' : 'effect_unknown', detail: outcome.detail });
        if (outcome.status === 'not_dispatched') {
          await move('NOT_DISPATCHED', outcome.detail);
          return outcome;
        }
        const reconcile = async () =>
          reconcileIntent((await intents.get(intent.intent_id))!, adapter, { signal: attemptSignal, settleMs: session.remainingMs(10_000) }).catch(
            (e: Error): Reconciliation => ({ state: 'NEEDS_REVIEW', receipts: [], detail: `effect lookup failed: ${e.message}` }),
          );
        if (outcome.status === 'done') {
          await move('ACKNOWLEDGED');
          if (key) {
            // Confirm the effect from the application, waiting out requests with this key that are still in flight.
            const rec = await reconcile();
            if (rec.state === 'NEEDS_REVIEW') {
              await move('NEEDS_REVIEW', rec.detail, rec.receipts);
              throw new Stop('NEEDS_REVIEW', 'effect_unreconciled', `${intent.description}: ${rec.detail}`);
            }
            await move(rec.happened ? 'EFFECT_CONFIRMED' : 'RECONCILED', rec.detail, rec.receipts);
          } else if (intent.effect !== 'none') awaitingSettlement.push(intent.intent_id);
          return outcome;
        }
        await move('EFFECT_UNKNOWN', outcome.detail);
        await move('RECONCILING');
        const rec = await reconcile();
        await move(rec.state, rec.detail, rec.receipts);
        if (rec.state === 'NEEDS_REVIEW') throw new Stop('NEEDS_REVIEW', 'effect_unreconciled', `${intent.description}: input may have been dispatched (${outcome.detail}); ${rec.detail}`);
        return { ...outcome, detail: `${outcome.detail}; reconciled: ${rec.detail}` };
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
          let r: Evaluation;
          try {
            r = await evaluateAssertion(a, {
              privacy: privacy(),
              page: p,
              fixtureData: fx?.data ?? {},
              fixtures: o.fixtures,
              baseline,
              consoleErrors,
              timeoutMs: session.remainingMs(s.budgets.assertion_timeout_ms),
              authorizeNavigation: (path) => authorizeAction({ policy: o.policy, scenario: s.policy, environment: o.environment, role: s.role, readOnly: !!o.readOnly }, { op: 'NAVIGATE', route: path, path }).allowed,
              quality: {
                baselines: o.quality?.baselines ?? null,
                scenario_id: s.id,
                execution_profile: profile,
                requirement_ids: s.requirement_ids,
                commit_sha: o.quality?.commitSha ?? null,
                ...(o.quality?.findings ? { findings: o.quality.findings } : {}),
                ...(o.quality?.reviewer ? { reviewer: o.quality.reviewer } : {}),
              },
            });
          } catch (e) {
            r = { type: a.type, status: 'failed', message: `assertion could not be evaluated: ${(e as Error).message}` };
          }
          const { attachments, ...plain } = r;
          const refs: string[] = [];
          for (const att of attachments ?? []) {
            const ref = await log.writeArtifact(att.kind, `${m.id}/${att.name}`, att.bytes);
            if (ref) refs.push(`${ref.path}#sha256=${ref.sha256}`);
          }
          const result: AssertionResult = { milestone_id: m.id, index: ai, elapsed_ms: Date.now() - t0, ...plain, ...(refs.length ? { message: [plain.message, ...refs.map((x) => `artifact: ${x}`)].filter(Boolean).join('\n') } : {}) };
          assertions.push(result);
          log.record('assertion', `${m.id}#${ai} ${a.type}: ${result.status}`, { ...result });
          if (result.status === 'failed' || result.status === 'not_run') failed.push(result);
        }
        await session.screenshot(m.id);
        if (failed.length === 0) {
          completed.push(m.id);
          log.record('milestone', `milestone ${m.id} verified`, { milestone: m.id });
        }
        return failed;
      },
      async screenshot(name) {
        const shot = await safeScreenshot(p, { ...privacy(), fullPage: true });
        if (shot.ok) await log.writeArtifact('screenshot', `${String(shotCount++).padStart(2, '0')}-${name}.png`, shot.png);
        else log.record('artifact', `screenshot ${name} withheld: ${shot.withheld}`, { withheld: true, reason: shot.withheld });
      },
    };

    const start = authorizeAction({ policy: o.policy, scenario: s.policy, environment: o.environment, role: s.role, readOnly: !!o.readOnly }, { op: 'NAVIGATE', route: '/', path: s.start_path });
    if (!start.allowed) throw new Stop('BLOCKED', 'policy_denied', `start page: ${start.reason}`);
    const response = await p.goto(s.start_path, { waitUntil: 'load', timeout: s.budgets.action_timeout_ms * 2 });
    session.checkpoint();
    if (fixture?.auth && o.signedOutPath && new URL(p.url()).pathname === o.signedOutPath) {
      throw new Stop('BLOCKED', 'auth_unavailable', `supplied session was not accepted: redirected to ${o.signedOutPath}`);
    }
    if (response && response.status() >= 500) throw new Stop('FAIL', 'step_failed', `start page returned HTTP ${response.status()}`);

    await drive(session);

    const expectedCount = s.milestones.reduce((n, m) => n + m.assertions.length, 0);
    const passed = assertions.filter((a) => a.status === 'passed').length;
    const review = assertions.filter((a) => a.status === 'needs_review').length;
    if (completed.length !== s.milestones.length || passed + review !== expectedCount || assertions.length !== expectedCount || passed === 0) {
      throw new Stop('ERROR', 'no_assertions_executed', `driver finished with ${completed.length}/${s.milestones.length} milestones and ${passed}/${expectedCount} assertions verified`);
    }
    if (review > 0) throw new Stop('NEEDS_REVIEW', 'visual_review_required', `${review} visual checkpoint(s) have no approved baseline; every other assertion passed`);
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
    // This worker kept custody from acknowledgement to the end of the attempt: the effect is settled, not uncertain.
    // A worker that dies before this point leaves the intent ACKNOWLEDGED, and recovery reconciles it.
    for (const id of awaitingSettlement) {
      await intents
        .transition(id, 'SETTLED', 'acknowledged by the application; the owning attempt finished under its live lease')
        .then(() => log.record('intent_transition', `${id} → SETTLED`, { intent_id: id, state: 'SETTLED' }))
        .catch((e: Error) => log.record('intent_transition', `${id} could not be settled (left for recovery): ${e.message}`, { intent_id: id, state: 'ACKNOWLEDGED' }));
    }
    // Every approved assertion is reported: anything not evaluated is visibly not_run.
    const reported = new Set(assertions.map((a) => `${a.milestone_id}#${a.index}`));
    for (const m of s.milestones) {
      m.assertions.forEach((a, ai) => {
        if (!reported.has(`${m.id}#${ai}`)) assertions.push({ milestone_id: m.id, index: ai, type: a.type, status: 'not_run', elapsed_ms: 0 });
      });
    }
    if (page && verdict !== 'PASS') {
      const shot = await safeScreenshot(page, { ...privacy(), fullPage: true });
      if (shot.ok) await log.writeArtifact('screenshot', 'failure.png', shot.png).catch(() => undefined);
      else log.record('artifact', `failure screenshot withheld: ${shot.withheld}`, { withheld: true, reason: shot.withheld });
    }
    if (context && tracing) {
      const tracePath = join(caseDir, 'trace.zip');
      await context.tracing
        .stop({ path: tracePath })
        .then(async () => log.registerSanitizedArchive('trace', tracePath))
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
