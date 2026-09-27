import type { Page } from '@playwright/test';
import { describeLocator, type ReasonCode, type Step } from '@qa/contracts';
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

/**
 * Execute one approved step. Uses Playwright's actionability checks (visible,
 * stable, enabled, receives events) via a trial pass first, so a failure
 * before dispatch is distinguishable from a failure after dispatch. `force`
 * is never used.
 */
export async function executeStep(step: Step, ctx: StepContext): Promise<StepOutcome> {
  const { page, timeoutMs } = ctx;
  if (step.op === 'navigate' || step.op === 'reload') {
    try {
      if (step.op === 'navigate') await page.goto(new URL(step.path, ctx.baseUrl).toString(), { timeout: timeoutMs, waitUntil: 'load' });
      else await page.reload({ timeout: timeoutMs, waitUntil: 'load' });
      return { status: 'done', detail: describeStep(step) };
    } catch (e) {
      return { status: 'effect_unknown', reason: 'step_failed', detail: msg(e) };
    }
  }

  if (step.op === 'press') {
    try {
      for (let i = 0; i < step.times; i++) await page.keyboard.press(step.key === 'Space' ? ' ' : step.key);
      if (step.key === 'Enter' || step.key === 'Space') await settle(page, timeoutMs);
      return { status: 'done', detail: describeStep(step) };
    } catch (e) {
      return { status: 'effect_unknown', reason: 'step_failed', detail: msg(e) };
    }
  }

  const locator = resolveLocator(page, step.target);
  try {
    const count = await locator.count();
    if (count > 1) return { status: 'not_dispatched', reason: 'step_target_unavailable', detail: `${describeLocator(step.target)} matched ${count} elements` };
    if (step.op === 'click') await locator.click({ trial: true, timeout: timeoutMs });
    else {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      if (!(await locator.isEnabled()) || (step.op === 'type' && !(await locator.isEditable()))) {
        return { status: 'not_dispatched', reason: 'step_target_unavailable', detail: `${describeLocator(step.target)} is not ${step.op === 'type' ? 'editable' : 'enabled'}` };
      }
    }
  } catch (e) {
    return { status: 'not_dispatched', reason: 'step_target_unavailable', detail: msg(e) };
  }

  try {
    switch (step.op) {
      case 'click':
        await locator.click({ timeout: timeoutMs });
        await settle(page, timeoutMs);
        break;
      case 'type':
        await locator.fill(step.value_ref ? ctx.resolveValue(step.value_ref) : step.value!, { timeout: timeoutMs });
        break;
      case 'select':
        await locator.selectOption({ label: step.option_ref ? ctx.resolveValue(step.option_ref) : step.option! }, { timeout: timeoutMs });
        break;
    }
    return { status: 'done', detail: describeStep(step) };
  } catch (e) {
    return { status: 'effect_unknown', reason: 'step_failed', detail: msg(e) };
  }
}
