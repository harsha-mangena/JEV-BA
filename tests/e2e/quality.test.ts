import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, observe } from '@qa/browser';
import type { CaseResult } from '@qa/contracts';
import type { DefectId } from '@qa/fixture-test-app';
import { approveFromEvidence, BaselineConflict, FindingLedger, FsBaselineStore, uxHypotheses, uxMetrics, type BaselineKey } from '@qa/quality';
import { runSuite } from '@qa/worker';
import { app, outDir, policy, scenario } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const SHA = '0'.repeat(40);

async function run(ids: string[], defects: DefectId[], baselines: FsBaselineStore | null, findings?: FindingLedger, profiles?: Array<'chromium_desktop' | 'chromium_mobile_viewport'>) {
  const { app: a, fixtures } = await app(defects);
  try {
    const out = await outDir();
    const { report, runDir } = await runSuite({
      scenarios: await Promise.all(ids.map((id) => scenario(id))),
      policy,
      baseUrl: a.url,
      environment: 'local',
      fixtures,
      outDir: out,
      browser,
      signedOutPath: '/login',
      concurrency: 2,
      quality: { baselines, ...(findings ? { findings } : {}) },
      ...(profiles ? { profiles } : {}),
    });
    return { report, runDir };
  } finally {
    await a.close();
  }
}

async function approveAll(store: FsBaselineStore, runDir: string, cases: CaseResult[]) {
  for (const c of cases) {
    for (const a of c.assertions.filter((x) => x.type === 'visual_match' && x.status === 'needs_review')) {
      const key = (a.expected as { key: BaselineKey }).key;
      const [, path, sha] = /artifact: (\S+)#sha256=([0-9a-f]{64})/.exec(a.message!)!;
      await approveFromEvidence(store, key, join(runDir, path!), sha!, { approved_by: 'reviewer@example.test', commit_sha: SHA, source: 'test', expected_version: (a.expected as { baseline_version?: number }).baseline_version ?? 0 });
    }
  }
}

const assertion = (c: CaseResult, type: string) => c.assertions.find((a) => a.type === type)!;

/** Seeded Phase 5 defects and the checker that must catch each one. */
export const QUALITY_DETECTION: Array<[DefectId, string, string, 'chromium_desktop' | 'chromium_mobile_viewport']> = [
  ['mobile_horizontal_overflow', 'cart_quality', 'layout_sound', 'chromium_mobile_viewport'],
  ['promo_overlay', 'cart_quality', 'layout_sound', 'chromium_desktop'],
  ['address_label_missing', 'cart_quality', 'a11y_scan', 'chromium_desktop'],
  ['focus_outline_removed', 'keyboard_checkout', 'focus_visible', 'chromium_desktop'],
  ['header_restyled', 'cart_quality', 'visual_match', 'chromium_desktop'],
];

describe('visual baselines', () => {
  it('a missing baseline is NEEDS_REVIEW, approval is explicit, and later runs compare against it', async () => {
    const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-bl-')));
    const first = await run(['cart_quality'], [], store);
    expect(first.report.cases.map((c) => [c.verdict, c.reason])).toEqual([
      ['NEEDS_REVIEW', 'visual_review_required'],
      ['NEEDS_REVIEW', 'visual_review_required'],
    ]);
    expect(first.report.gate.eligible).toBe(false);
    for (const c of first.report.cases) {
      expect(assertion(c, 'layout_sound').status).toBe('passed');
      expect(assertion(c, 'a11y_scan').status).toBe('passed');
    }
    await approveAll(store, first.runDir, first.report.cases);
    expect((await store.list()).map((r) => r.version)).toEqual([1, 1]);

    const second = await run(['cart_quality'], [], store);
    expect(second.report.cases.map((c) => c.verdict)).toEqual(['PASS', 'PASS']);
    expect(second.report.gate.eligible).toBe(true);
  });

  it('refuses approvals without a commit, with a tampered candidate, or without an approver', async () => {
    const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-bl-')));
    const first = await run(['cart_quality'], [], store, undefined, ['chromium_desktop']);
    const a = assertion(first.report.cases[0]!, 'visual_match');
    const key = (a.expected as { key: BaselineKey }).key;
    const [, path, sha] = /artifact: (\S+)#sha256=([0-9a-f]{64})/.exec(a.message!)!;
    const png = await readFile(join(first.runDir, path!));
    await expect(store.approve(key, png, { approved_by: 'x', commit_sha: 'main', source: 't', expected_sha256: sha!, expected_version: 0 })).rejects.toThrow(/commit SHA/);
    await expect(store.approve(key, png, { approved_by: 'x', commit_sha: SHA, source: 't', expected_sha256: 'f'.repeat(64), expected_version: 0 })).rejects.toThrow(/checksum/);
    await expect(store.approve(key, png, { approved_by: ' ', commit_sha: SHA, source: 't', expected_sha256: sha!, expected_version: 0 })).rejects.toThrow(/approver/);
    // Compare-and-set: two reviewers approving against the same baseline version — only the first wins.
    const first1 = await Promise.allSettled([0, 1].map(() => store.approve(key, png, { approved_by: 'r1', commit_sha: SHA, source: 't', expected_sha256: sha!, expected_version: 0 })));
    expect(first1.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(first1.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.any(BaselineConflict)]);
    await expect(store.approve(key, png, { approved_by: 'r2', commit_sha: SHA, source: 't', expected_sha256: sha!, expected_version: 0 })).rejects.toBeInstanceOf(BaselineConflict);
    expect((await store.approve(key, png, { approved_by: 'r2', commit_sha: SHA, source: 't', expected_sha256: sha!, expected_version: 1 })).version).toBe(2);
  });

  it('an unapproved visual change fails with a diff, and repeated occurrences do not multiply findings', async () => {
    const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-bl-')));
    const first = await run(['cart_quality'], [], store, undefined, ['chromium_desktop']);
    await approveAll(store, first.runDir, first.report.cases);
    const findings = new FindingLedger();
    for (let i = 0; i < 3; i++) {
      const r = await run(['cart_quality'], ['header_restyled'], store, findings, ['chromium_desktop']);
      const v = assertion(r.report.cases[0]!, 'visual_match');
      expect(v.status).toBe('failed');
      expect(v.message).toMatch(/visual\/cart\.diff\.png/);
      expect(r.report.cases[0]!.artifacts.some((x) => x.kind === 'visual_diff')).toBe(true);
    }
    const visual = findings.all().filter((f) => f.kind === 'visual_diff');
    expect(visual).toHaveLength(1);
    expect(visual[0]).toMatchObject({ occurrences: 3, certainty: 'suspected', commits: [] });
  });
});

describe.concurrent('layout, accessibility and keyboard checks', () => {
  it('clean keyboard journey passes with visible focus', async () => {
    const { report } = await run(['keyboard_checkout'], [], null);
    expect(report.cases[0]!.verdict, report.cases[0]!.message ?? '').toBe('PASS');
  });

  it.concurrent.each(QUALITY_DETECTION.filter(([d]) => d !== 'header_restyled'))('%s is caught by %s (%s)', async (defect, id, check, profile) => {
    const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-bl-')));
    const { report } = await run([id], [defect], store, undefined, [profile]);
    const c = report.cases[0]!;
    expect(c.verdict).toBe('FAIL');
    expect(assertion(c, check).status).toBe('failed');
  });

  it('the overlay also blocks the approved checkout click before any input is dispatched', async () => {
    const { report } = await run(['checkout_existing_customer'], ['promo_overlay'], null, undefined, ['chromium_desktop']);
    expect(report.cases[0]).toMatchObject({ verdict: 'FAIL', reason: 'step_target_unavailable' });
  });

  it('horizontal overflow only affects the narrow viewport', async () => {
    const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-bl-')));
    const { report } = await run(['cart_quality'], ['mobile_horizontal_overflow'], store);
    const byProfile = Object.fromEntries(report.cases.map((c) => [c.execution_profile, assertion(c, 'layout_sound')]));
    expect(byProfile.chromium_desktop!.status).toBe('passed');
    expect(byProfile.chromium_mobile_viewport!.status).toBe('failed');
    expect(JSON.stringify(byProfile.chromium_mobile_viewport!.actual)).toMatch(/horizontal_overflow/);
  });
});

describe('UX hypotheses', () => {
  it('require structural corroboration; model uncertainty alone yields only a metric', async () => {
    const { app: a, fixtures } = await app(['ambiguous_checkout_labels']);
    const ctx = await browser.newContext();
    try {
      const f = await fixtures.provision('customer_cart_one_item_v1');
      await ctx.addCookies(f.auth!.cookies.map((c) => ({ ...c, url: a.url })));
      const page = await ctx.newPage();
      await page.goto(`${a.url}/cart`);
      const obs = await observe(page, { pageId: 'p' });
      const noisy = uxMetrics([{ route: '/cart', outcome: 'ESCALATE', reason_codes: ['target_uncertain'] }, { route: '/cart', outcome: 'ACT', reason_codes: [] }]);
      const hyps = uxHypotheses([obs], noisy);
      expect(hyps).toHaveLength(1);
      expect(hyps[0]!.title).toMatch(/^Potentially unclear choice: 2 buttons named "continue"/);
      expect(hyps[0]!.certainty).toBe('suspected');
      expect(JSON.stringify(hyps)).not.toMatch(/users? (are|were|is) confused/i);

      // Same escalation density on a page without structural ambiguity: no hypothesis.
      await page.goto(`${a.url}/products`);
      const clean = await observe(page, { pageId: 'p' });
      expect(uxHypotheses([clean], uxMetrics([{ route: '/products', outcome: 'ESCALATE', reason_codes: ['target_uncertain'] }]))).toEqual([]);
      // Structural duplicates without elevated uncertainty: no hypothesis either.
      expect(uxHypotheses([obs], uxMetrics([{ route: '/cart', outcome: 'ACT', reason_codes: [] }]))).toEqual([]);
    } finally {
      await ctx.close();
      await a.close();
    }
  });
});
