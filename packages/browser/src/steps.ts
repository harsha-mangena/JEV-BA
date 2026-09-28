import type { Locator, Page } from '@playwright/test';
import { describeLocator, type ActionRequest, type ControlIdentity, type ReasonCode, type Step } from '@qa/contracts';
import { identifyFocused, identifyLocator } from './identify.ts';
import { resolveLocator } from './locators.ts';

export type StepOutcome =
  | { status: 'done'; detail: string }
  /** Actionability failed before any input was dispatched; safe to report, nothing happened. */
  | { status: 'not_dispatched'; reason: ReasonCode; detail: string }
  /** Input may have been dispatched; the effect is unknown and must be inspected, never blindly retried. */
  | { status: 'effect_unknown'; reason: ReasonCode; detail: string };

export interface StepContext {
  page: Page;
  baseUrl: string;
  timeoutMs: number;
  /** Resolves a `value_ref`/`option_ref`; secrets are resolved here and nowhere else. */
  resolveValue(ref: string): string;
}

export function describeStep(step: Step): string {
  switch (step.op) {
    case 'navigate':
      return `navigate ${step.path}`;
    case 'reload':
      return 'reload';
    case 'press':
      return `press ${step.key}${step.times > 1 ? ` ×${step.times}` : ''}`;
    case 'click':
      return `click ${describeLocator(step.target)}`;
    case 'type':
      return `type ${step.value_ref ?? '<literal>'} into ${describeLocator(step.target)}`;
    case 'select':
      return `select ${step.option_ref ?? JSON.stringify(step.option)} in ${describeLocator(step.target)}`;
  }
}

/**
 * Let a click's consequences land (form submission, navigation, XHR) before
 * any assertion runs. Without this, a "no new order" assertion could pass
 * simply because the submission had not reached the server yet.
 */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5_000) }).catch(() => undefined);
}

const msg = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e));

export type PreparedStep =
  | { kind: 'navigation'; step: Extract<Step, { op: 'navigate' | 'reload' }>; route: string }
  | { kind: 'keys'; step: Extract<Step, { op: 'press' }>; route: string; focused: (ControlIdentity & { tag: string }) | null }
  | { kind: 'element'; step: Extract<Step, { op: 'click' | 'type' | 'select' }>; route: string; locator: Locator; identity: ControlIdentity & { tag: string } };

export type PrepareResult = { ok: true; prepared: PreparedStep } | { ok: false; outcome: StepOutcome };

/**
 * Resolve and check a step without dispatching any input: the unique target,
 * Playwright actionability (trial pass for clicks), and the control identity
 * the authorization service needs. Nothing here can change application state.
 */
export async function prepareStep(step: Step, ctx: StepContext): Promise<PrepareResult> {
  const { page, timeoutMs } = ctx;
  const route = new URL(page.url()).pathname;
  if (step.op === 'navigate' || step.op === 'reload') return { ok: true, prepared: { kind: 'navigation', step, route } };
  if (step.op === 'press') return { ok: true, prepared: { kind: 'keys', step, route, focused: await identifyFocused(page) } };
  const locator = resolveLocator(page, step.target);
  try {
    const count = await locator.count();
    if (count !== 1) return { ok: false, outcome: { status: 'not_dispatched', reason: 'step_target_unavailable', detail: `${describeLocator(step.target)} matched ${count} elements` } };
    if (step.op === 'click') await locator.click({ trial: true, timeout: timeoutMs });
    else {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (!(await locator.isEnabled()) || (step.op === 'type' && !(await locator.isEditable()))) {
        return { ok: false, outcome: { status: 'not_dispatched', reason: 'step_target_unavailable', detail: `${describeLocator(step.target)} is not ${step.op === 'type' ? 'editable' : 'enabled'}` } };
      }
    }
    return { ok: true, prepared: { kind: 'element', step, route, locator, identity: await identifyLocator(page, locator) } };
  } catch (e) {
    return { ok: false, outcome: { status: 'not_dispatched', reason: 'step_target_unavailable', detail: msg(e) } };
  }
}

/** Build the authorization request for a prepared step. */
export function actionRequestFor(p: PreparedStep): ActionRequest {
  switch (p.kind) {
    case 'navigation':
      return p.step.op === 'navigate' ? { op: 'NAVIGATE', route: p.route, path: p.step.path, declared_intent: p.step.intent } : { op: 'RELOAD', route: p.route, declared_intent: p.step.intent };
    case 'keys':
      return { op: 'PRESS', route: p.route, key: p.step.key, control: p.focused, declared_intent: p.step.intent };
    case 'element': {
      const control = { role: p.identity.role, name: p.identity.name, form: p.identity.form, section: p.identity.section };
      if (p.step.op === 'click') return { op: 'CLICK', route: p.route, control, declared_intent: p.step.intent };
      const ref = p.step.op === 'type' ? p.step.value_ref : p.step.option_ref;
      return { op: p.step.op === 'type' ? 'TYPE' : 'SELECT', route: p.route, control, declared_intent: p.step.intent, parameter: ref ? { kind: 'ref', ref } : { kind: 'literal' } };
    }
  }
}

/**
 * Dispatch a prepared, authorized step exactly once. A failure after this
 * point is `effect_unknown`: input may have reached the application.
 */
export async function dispatchStep(p: PreparedStep, ctx: StepContext): Promise<StepOutcome> {
  const { page, timeoutMs } = ctx;
  const step = p.step;
  try {
    switch (p.kind) {
      case 'navigation':
        if (p.step.op === 'navigate') await page.goto(new URL(p.step.path, ctx.baseUrl).toString(), { timeout: timeoutMs, waitUntil: 'load' });
        else await page.goto(page.url(), { timeout: timeoutMs, waitUntil: 'load' });
        break;
      case 'keys':
        for (let i = 0; i < p.step.times; i++) await page.keyboard.press(p.step.key === 'Space' ? ' ' : p.step.key);
        if (p.step.key === 'Enter' || p.step.key === 'Space') await settle(page, timeoutMs);
        break;
      case 'element':
        if (p.step.op === 'click') {
          await p.locator.click({ timeout: timeoutMs });
          await settle(page, timeoutMs);
        } else if (p.step.op === 'type') await p.locator.fill(p.step.value_ref ? ctx.resolveValue(p.step.value_ref) : p.step.value!, { timeout: timeoutMs });
        else await p.locator.selectOption({ label: p.step.option_ref ? ctx.resolveValue(p.step.option_ref) : p.step.option! }, { timeout: timeoutMs });
        break;
    }
    return { status: 'done', detail: describeStep(step) };
  } catch (e) {
    return { status: 'effect_unknown', reason: 'step_failed', detail: msg(e) };
  }
}
