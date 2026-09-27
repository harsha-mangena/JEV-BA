import type { Page } from '@playwright/test';
import { describeLocator, parseRef, type Assertion, type AssertionResult } from '@qa/contracts';
import { pollUntil, resolveLocator } from '@qa/browser';
import type { FixtureClient, OwnedOrder } from './fixture-client.ts';

export interface EntityBaseline {
  orders: Map<string, OwnedOrder[]>;
  notes: Map<string, number>;
}

export interface AssertionContext {
  page: Page;
  fixtureData: Record<string, string | number | boolean>;
  fixtures: FixtureClient;
  baseline: EntityBaseline;
  consoleErrors: readonly string[];
  timeoutMs: number;
}

type Evaluation = Omit<AssertionResult, 'milestone_id' | 'index' | 'elapsed_ms'>;

/** Resolve a fixture reference. Secret references are rejected by semantic validation before this point. */
export function fixtureValue(ctx: Pick<AssertionContext, 'fixtureData'>, ref: string): string | number | boolean {
  const { scope, field } = parseRef(ref);
  if (scope !== 'fixture') throw new Error(`assertions may not reference ${scope} values`);
  const v = ctx.fixtureData[field];
  if (v === undefined) throw new Error(`fixture field ${field} was not provisioned`);
  return v;
}

function integerRef(ctx: AssertionContext, ref: string): number {
  const v = fixtureValue(ctx, ref);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error(`${ref} must be an integer, got ${JSON.stringify(v)}`);
  return v;
}

const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();

async function uniqueText(page: Page, target: Parameters<typeof resolveLocator>[1]): Promise<{ count: number; text: string | null }> {
  const loc = resolveLocator(page, target);
  const count = await loc.count();
  if (count !== 1) return { count, text: null };
  return { count, text: normalizeText(await loc.innerText({ timeout: 1_000 }).catch(() => '')) };
}

async function isVisibleUnique(page: Page, target: Parameters<typeof resolveLocator>[1]): Promise<{ count: number; visible: boolean }> {
  const loc = resolveLocator(page, target);
  const count = await loc.count();
  return { count, visible: count === 1 && (await loc.isVisible()) };
}

/**
 * Evaluate a single approved assertion. Probes are retried until a deadline
 * (for eventual UI/backend state), but no business action is ever repeated.
 * Exact comparisons — integers, strings, counts — are performed in code.
 */
export async function evaluateAssertion(a: Assertion, ctx: AssertionContext): Promise<Evaluation> {
  const t = ctx.timeoutMs;
  switch (a.type) {
    case 'ui_visible': {
      const r = await pollUntil(() => isVisibleUnique(ctx.page, a.target), (v) => v.visible, t);
      return {
        type: a.type,
        status: r.ok ? 'passed' : 'failed',
        expected: { target: describeLocator(a.target), visible: true },
        actual: r.value,
        ...(r.ok ? {} : { message: r.value.count > 1 ? `ambiguous: ${r.value.count} matches` : `${describeLocator(a.target)} not visible` }),
      };
    }
    case 'ui_hidden': {
      const loc = resolveLocator(ctx.page, a.target);
      const r = await pollUntil(async () => ({ count: await loc.count(), visible: await loc.first().isVisible().catch(() => false) }), (v) => !v.visible, t);
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: { target: describeLocator(a.target), visible: false }, actual: r.value, ...(r.ok ? {} : { message: `${describeLocator(a.target)} is visible` }) };
    }
    case 'ui_text': {
      const expected = a.equals ?? (a.equals_ref ? String(fixtureValue(ctx, a.equals_ref)) : undefined);
      const want = expected !== undefined ? normalizeText(expected) : undefined;
      const check = (v: { text: string | null }) => v.text !== null && (want !== undefined ? v.text === want : v.text.includes(a.contains!));
      const r = await pollUntil(() => uniqueText(ctx.page, a.target), check, t);
      return {
        type: a.type,
        status: r.ok ? 'passed' : 'failed',
        expected: want !== undefined ? { equals: want } : { contains: a.contains },
        actual: r.value.text,
        ...(r.ok ? {} : { message: r.value.count !== 1 ? `${describeLocator(a.target)} matched ${r.value.count} elements` : 'text mismatch' }),
      };
    }
    case 'url_path': {
      const r = await pollUntil(async () => new URL(ctx.page.url()).pathname, (p) => p === a.equals, t);
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: a.equals, actual: r.value };
    }
    case 'order_count_delta':
    case 'entity_count_delta': {
      const entity = a.type === 'order_count_delta' ? 'order' : a.entity;
      const owner = String(fixtureValue(ctx, a.type === 'order_count_delta' ? a.customer_ref : a.owner_ref));
      const before = entity === 'order' ? (ctx.baseline.orders.get(owner)?.length ?? 0) : (ctx.baseline.notes.get(owner) ?? 0);
      const count = async () => (entity === 'order' ? (await ctx.fixtures.orders(owner)).length : (await ctx.fixtures.notes(owner)).length);
      const r = await pollUntil(async () => (await count()) - before, (d) => d === a.equals, t, 200);
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: { entity, delta: a.equals }, actual: { delta: r.value, before } };
    }
    case 'order_total_minor_units': {
      const expected = a.equals ?? integerRef(ctx, a.equals_ref!);
      const owner = a.customer_ref ? String(fixtureValue(ctx, a.customer_ref)) : String(fixtureValue(ctx, 'fixture.customer_id'));
      const known = new Set((ctx.baseline.orders.get(owner) ?? []).map((o) => o.id));
      const r = await pollUntil(async () => (await ctx.fixtures.orders(owner)).filter((o) => !known.has(o.id)), (n) => n.length > 0, t, 200);
      if (r.value.length !== 1) {
        return { type: a.type, status: 'failed', expected, actual: r.value.map((o) => o.total_minor_units), message: `expected exactly one new order to check, found ${r.value.length}` };
      }
      const actual = r.value[0]!.total_minor_units;
      return { type: a.type, status: actual === expected ? 'passed' : 'failed', expected, actual, ...(actual === expected ? {} : { message: `total differs by ${actual - expected} minor units` }) };
    }
    case 'persists_after_reload': {
      await ctx.page.reload({ waitUntil: 'load', timeout: t });
      const r = await pollUntil(() => isVisibleUnique(ctx.page, a.target), (v) => v.visible, t);
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: { target: describeLocator(a.target), visible_after_reload: true }, actual: r.value };
    }
    case 'no_console_errors': {
      const errors = [...ctx.consoleErrors];
      return { type: a.type, status: errors.length === 0 ? 'passed' : 'failed', expected: [], actual: errors, ...(errors.length ? { message: `${errors.length} console error(s)` } : {}) };
    }
  }
}

export async function captureBaseline(fixtures: FixtureClient, owners: Iterable<string>): Promise<EntityBaseline> {
  const baseline: EntityBaseline = { orders: new Map(), notes: new Map() };
  for (const owner of owners) {
    baseline.orders.set(owner, await fixtures.orders(owner));
    baseline.notes.set(owner, (await fixtures.notes(owner)).length);
  }
  return baseline;
}
