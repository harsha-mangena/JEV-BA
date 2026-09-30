import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import { PNG } from 'pngjs';
import { launchBrowser, MASK_COLOR, observe, safeScreenshot } from '@qa/browser';
import { AnthropicVisionS2Provider, validateS2Proposal } from '@qa/s2';
import { startFixtureApp } from '@qa/fixture-test-app';
import { FixtureClient } from '@qa/oracles';

/**
 * Live vision System Two probe against the Claude Messages API with a real
 * screenshot of the fixture checkout. Never passes without credentials: the
 * lane runner records it as BLOCKED when ANTHROPIC_API_KEY is absent.
 *
 * The image goes through the same publication boundary as production
 * (`safeScreenshot`), and a synthetic canary — shown inside a closed shadow
 * root on a plain div, where page script cannot read it — is checked on the
 * decoded pixels before anything is sent: the request carries the sanitized
 * rendering, never a raw capture.
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
      const canary = `live-s2-canary-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12)}`;
      const showCanary = (text: string) =>
        page.evaluate((t) => {
          document.getElementById('qa-canary')?.remove();
          const host = document.createElement('div');
          host.id = 'qa-canary';
          host.style.cssText = 'position:fixed;left:8px;bottom:8px;font:20px sans-serif;color:#000;background:#fff;z-index:9';
          document.body.append(host);
          host.attachShadow({ mode: 'closed' }).textContent = t;
        }, text);
      await showCanary('');
      const blank = PNG.sync.read(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
      await showCanary(canary);
      const rawPng = PNG.sync.read(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
      const glyph: number[] = [];
      for (let i = 0; i < rawPng.data.length; i += 4) if (rawPng.data[i] !== blank.data[i] || rawPng.data[i + 1] !== blank.data[i + 1] || rawPng.data[i + 2] !== blank.data[i + 2]) glyph.push(i);
      expect(glyph.length, 'control: the canary really paints').toBeGreaterThan(100);
      const safe = await safeScreenshot(page, { secrets: [canary] });
      if (!safe.ok) throw new Error(`BLOCKED: the S2 image was withheld by the privacy boundary: ${safe.withheld}`);
      const out = PNG.sync.read(safe.png);
      const [mr, mg, mb] = [1, 3, 5].map((i) => parseInt(MASK_COLOR.slice(i, i + 2), 16));
      const leaked = glyph.filter((i) => !(out.data[i] === blank.data[i] && out.data[i + 1] === blank.data[i + 1] && out.data[i + 2] === blank.data[i + 2]) && !(Math.abs(out.data[i]! - mr!) < 8 && Math.abs(out.data[i + 1]! - mg!) < 8 && Math.abs(out.data[i + 2]! - mb!) < 8));
      expect(leaked.length, 'canary pixels in the image about to be sent').toBe(0);
      const shot = safe.png;
      const p = new AnthropicVisionS2Provider(process.env.QA_S2_MODEL ? { model: process.env.QA_S2_MODEL } : {});
      const raw = await p.propose({ goal: 'Place the fixture order', milestone_id: 'order_persisted', observation: obs, s1_distributions: {}, unmet_assertions: ['ui_visible', 'order_count_delta'], environment_policy_summary: 'environment=local; mutations=test_owned_order_create', missing_information: ['target_uncertain'], screenshot_png: shot });
      const v = validateS2Proposal(raw, obs);
      await mkdir(join(ROOT, '.qa-work', 'evidence'), { recursive: true });
      await writeFile(join(ROOT, '.qa-work', 'evidence', 's2-vision-live.json'), `${JSON.stringify({ requested_model: p.model, resolved_model: p.lastResolvedModel, proposal: raw, valid: v.ok, image: { sha256: createHash('sha256').update(shot).digest('hex'), sanitized: true, canary_glyph_pixels: glyph.length, canary_pixels_leaked: leaked.length, masked_regions: safe.masked }, at: new Date().toISOString() }, null, 2)}\n`);
      expect(v.ok).toBe(true);
      expect(p.lastResolvedModel).toBeTruthy();
    } finally {
      await ctx.close();
      await app.close();
    }
  });
});
