import type { Page } from '@playwright/test';
import { describeLocator, parseRef, type Assertion, type AssertionResult } from '@qa/contracts';
import { pollUntil, resolveLocator } from '@qa/browser';
import type { FixtureClient, OwnedOrder } from './fixture-client.ts';
import { atOrAbove, captureCheckpoint, checkLayout, compareImages, diffSignature, focusIndicator, isFocused, renderingProfile, reviewDiff, scanAccessibility, type BaselineStore, type FindingLedger, type VisualReviewer } from '@qa/quality';
import { createHash } from 'node:crypto';

export interface EntityBaseline {
  orders: Map<string, OwnedOrder[]>;
  notes: Map<string, number>;
}

export interface QualityContext {
  baselines: BaselineStore | null;
  scenario_id: string;
  execution_profile: string;
  requirement_ids: string[];
  commit_sha: string | null;
  findings?: FindingLedger;
  reviewer?: VisualReviewer;
}

export interface Attachment {
  kind: 'visual_candidate' | 'visual_diff' | 'a11y';
  name: string;
  bytes: Buffer;
}

export interface AssertionContext {
  quality?: QualityContext;
  /** Navigation authorization for assertions that re-load a page (defaults to allowed for standalone use). */
  authorizeNavigation?(path: string): boolean;
  page: Page;
  fixtureData: Record<string, string | number | boolean>;
  fixtures: FixtureClient;
  baseline: EntityBaseline;
  consoleErrors: readonly string[];
  timeoutMs: number;
}

export type Evaluation = Omit<AssertionResult, 'milestone_id' | 'index' | 'elapsed_ms'> & { attachments?: Attachment[] };

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
      // A GET of the current URL, never a browser reload: reloading a POST result would resubmit the form.
      const path = new URL(ctx.page.url()).pathname;
      if (ctx.authorizeNavigation && !ctx.authorizeNavigation(path)) {
        return { type: a.type, status: 'failed', expected: { target: describeLocator(a.target), visible_after_reload: true }, actual: null, message: `re-loading ${path} is not an authorized navigation in the application contract` };
      }
      await ctx.page.goto(ctx.page.url(), { waitUntil: 'load', timeout: t });
      const r = await pollUntil(() => isVisibleUnique(ctx.page, a.target), (v) => v.visible, t);
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: { target: describeLocator(a.target), visible_after_reload: true }, actual: r.value };
    }
    case 'focused': {
      const loc = resolveLocator(ctx.page, a.target);
      const r = await pollUntil(() => isFocused(loc), (v) => v, t);
      const active = await ctx.page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${(el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim().slice(0, 40)}` : null;
      });
      return { type: a.type, status: r.ok ? 'passed' : 'failed', expected: describeLocator(a.target), actual: active };
    }
    case 'focus_visible': {
      const ind = await focusIndicator(ctx.page);
      return { type: a.type, status: ind.visible ? 'passed' : 'failed', expected: 'visible focus indicator', actual: ind, ...(ind.visible ? {} : { message: ind.element ? `no focus indicator on ${ind.element}` : 'nothing is focused' }) };
    }
    case 'visual_match':
      return visualMatch(a, ctx);
    case 'a11y_scan': {
      const all = await scanAccessibility(ctx.page, { disableRules: a.disable_rules });
      const blocking = all.filter((v) => atOrAbove(v, a.fail_on));
      for (const v of blocking) recordFinding(ctx, 'a11y', `a11y:${ctx.page.url()}`, `${v.id}:${v.targets[0] ?? ''}`, `${v.help} (${v.impact}, ${v.nodes} node(s))`);
      return {
        type: a.type,
        status: blocking.length ? 'failed' : 'passed',
        expected: { violations_at_or_above: a.fail_on, count: 0 },
        actual: blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes, targets: v.targets })),
        ...(blocking.length ? { message: blocking.map((v) => v.id).join(', ') } : {}),
        attachments: [{ kind: 'a11y', name: `a11y-${Date.now()}.json`, bytes: Buffer.from(JSON.stringify(all, null, 2)) }],
      };
    }
    case 'layout_sound': {
      const issues = await checkLayout(ctx.page, a.checks);
      for (const i of issues) recordFinding(ctx, 'layout', i.check, `${i.check}:${i.element}`, `${i.check}: ${i.element} — ${i.detail}`);
      return { type: a.type, status: issues.length ? 'failed' : 'passed', expected: { issues: 0, checks: a.checks }, actual: issues, ...(issues.length ? { message: issues.map((i) => i.check).join(', ') } : {}) };
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

function recordFinding(ctx: AssertionContext, kind: 'a11y' | 'layout' | 'visual_diff', checkpoint: string, signature: string, summary: string): void {
  const q = ctx.quality;
  if (!q?.findings) return;
  q.findings.record({ kind, scenario_id: q.scenario_id, checkpoint, execution_profile: q.execution_profile, requirement_ids: q.requirement_ids, certainty: 'suspected', summary, signature, commit_sha: q.commit_sha, evidence: ctx.page.url() });
}

async function visualMatch(a: Extract<Assertion, { type: 'visual_match' }>, ctx: AssertionContext): Promise<Evaluation> {
  const q = ctx.quality;
  const png = await captureCheckpoint(ctx.page, a.mask.map((m) => resolveLocator(ctx.page, m)), a.full_page);
  const candidateSha = createHash('sha256').update(png).digest('hex');
  const candidate: Attachment = { kind: 'visual_candidate', name: `visual/${a.checkpoint}.candidate.png`, bytes: png };
  if (!q?.baselines) {
    return { type: a.type, status: 'needs_review', expected: { checkpoint: a.checkpoint }, actual: { candidate_sha256: candidateSha }, message: 'no baseline store configured; candidate captured for review', attachments: [candidate] };
  }
  const key = { scenario_id: q.scenario_id, checkpoint: a.checkpoint, execution_profile: q.execution_profile, rendering_profile: await renderingProfile(ctx.page) };
  const base = await q.baselines.get(key);
  if (!base) {
    return { type: a.type, status: 'needs_review', expected: { checkpoint: a.checkpoint, baseline: null, baseline_version: 0, key }, actual: { candidate_sha256: candidateSha }, message: 'no approved baseline for this checkpoint and rendering profile; approve the candidate to enable comparison', attachments: [candidate] };
  }
  const d = compareImages(base.png, png);
  const ok = d.comparable && d.diff_ratio <= a.max_diff_ratio;
  if (ok) return { type: a.type, status: 'passed', expected: { baseline_version: base.record.version, max_diff_ratio: a.max_diff_ratio }, actual: { diff_ratio: d.diff_ratio } };
  recordFinding(ctx, 'visual_diff', a.checkpoint, diffSignature(d.bbox), `visual difference at checkpoint ${a.checkpoint}: ${d.detail}`);
  const review = await reviewDiff(q.reviewer, { baseline: base.png, candidate: png, diff: d.diff_png, checkpoint: a.checkpoint, scenario_id: q.scenario_id });
  return {
    type: a.type,
    status: 'failed',
    expected: { baseline_version: base.record.version, baseline_sha256: base.record.sha256, max_diff_ratio: a.max_diff_ratio, key },
    actual: { diff_ratio: d.diff_ratio, diff_pixels: d.diff_pixels, bbox: d.bbox, candidate_sha256: candidateSha, ...(review ? { review_hint: review } : {}) },
    message: d.comparable ? `${(d.diff_ratio * 100).toFixed(3)}% of pixels differ` : d.detail,
    attachments: [candidate, ...(d.diff_png ? [{ kind: 'visual_diff' as const, name: `visual/${a.checkpoint}.diff.png`, bytes: d.diff_png }] : [])],
  };
}
