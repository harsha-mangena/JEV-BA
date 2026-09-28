import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import { launchBrowser, observe } from '@qa/browser';
import { AnthropicVisionS2Provider, validateS2Proposal } from '@qa/s2';
import { startFixtureApp } from '@qa/fixture-test-app';
import { FixtureClient } from '@qa/oracles';

/**
 * Live vision System Two probe against the Claude Messages API with a real
 * screenshot of the fixture checkout. Never passes without credentials: the
 * lane runner records it as BLOCKED when ANTHROPIC_API_KEY is absent.
 */
const configured = !!process.env.ANTHROPIC_API_KEY;
const ROOT = join(import.meta.dirname, '../..');
let browser: Browser;

if (!configured && process.env.QA_REQUIRE_LIVE === '1') {
  it('live System Two credentials are configured', () => {
    throw new Error('BLOCKED: ANTHROPIC_API_KEY is not set; live vision S2 verification cannot run');
  });
}

describe.skipIf(!configured)('live vision System Two', () => {
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('returns a valid bounded proposal for an ambiguous checkout with a screenshot', async () => {
    const token = 'live-s2-fixture-token-000';
    const app = await startFixtureApp({ fixtureToken: token, defects: ['ambiguous_checkout_labels'] });
    const ctx = await browser.newContext();
    try {
      const f = await new FixtureClient(app.url, token).provision('customer_cart_one_item_v1');
      await ctx.addCookies(f.auth!.cookies.map((c) => ({ ...c, url: app.url })));
      const page = await ctx.newPage();
      await page.goto(`${app.url}/cart`);
      const obs = await observe(page, { pageId: 'live' });
      const shot = await page.screenshot({ type: 'png' });
      const p = new AnthropicVisionS2Provider(process.env.QA_S2_MODEL ? { model: process.env.QA_S2_MODEL } : {});
      const raw = await p.propose({ goal: 'Place the fixture order', milestone_id: 'order_persisted', observation: obs, s1_distributions: {}, unmet_assertions: ['ui_visible', 'order_count_delta'], environment_policy_summary: 'environment=local; mutations=test_owned_order_create', missing_information: ['target_uncertain'], screenshot_png: shot });
      const v = validateS2Proposal(raw, obs);
      await mkdir(join(ROOT, '.qa-work', 'evidence'), { recursive: true });
      await writeFile(join(ROOT, '.qa-work', 'evidence', 's2-vision-live.json'), `${JSON.stringify({ requested_model: p.model, resolved_model: p.lastResolvedModel, proposal: raw, valid: v.ok, at: new Date().toISOString() }, null, 2)}\n`);
      expect(v.ok).toBe(true);
      expect(p.lastResolvedModel).toBeTruthy();
    } finally {
      await ctx.close();
      await app.close();
    }
  });
});
