import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, MASK_COLOR, safeScreenshot } from '@qa/browser';
import { readZip, sanitizeTraceArchive, writeZip } from '@qa/evidence';
import { KeywordProvider } from '@qa/s1';
import type { S2EscalationInput } from '@qa/s2';
import { runSuite } from '@qa/worker';
import { app, outDir, policy, scenario } from './helpers.ts';

/**
 * Re-audit R4: secrets rendered into pixels. Text redaction cannot make an
 * image safe, so every captured image — evidence screenshots, visual
 * checkpoints and the S2 request image — is masked in the page before
 * capture, and traces are published without image resources. Checks are made
 * on the decoded pixels, with positive controls that useful evidence survives.
 */

const TOKEN = 'tok-9f3a-SECRET-77c1';
const [R, G, B] = [0xff, 0x00, 0xff];
expect(MASK_COLOR).toBe('#FF00FF');

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/** Share of pixels inside a box (shrunk by 1px against anti-aliasing) that are the mask colour. */
function maskedShare(png: Buffer, box: { x: number; y: number; width: number; height: number }): number {
  const img = PNG.sync.read(png);
  let n = 0;
  let m = 0;
  for (let y = Math.ceil(box.y) + 1; y < Math.floor(box.y + box.height) - 1; y++) {
    for (let x = Math.ceil(box.x) + 1; x < Math.floor(box.x + box.width) - 1; x++) {
      const i = (y * img.width + x) * 4;
      n++;
      if (Math.abs(img.data[i]! - R) < 8 && Math.abs(img.data[i + 1]! - G) < 8 && Math.abs(img.data[i + 2]! - B) < 8) m++;
    }
  }
  return n === 0 ? 0 : m / n;
}

async function leakPage(page: Page) {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent(`<!doctype html><html><body style="margin:0;font:16px sans-serif">
    <h1 id="ok" style="margin:8px">Order summary</h1>
    <p id="text">Your API token is ${TOKEN}.</p>
    <input id="field" type="text" value="${TOKEN}" style="width:320px">
    <details open id="details"><summary>Recovery</summary><div id="inside">code: ${TOKEN}</div></details>
    <p id="split">token: <b>${TOKEN.slice(0, 8)}</b><i>${TOKEN.slice(8)}</i></p>
    <p id="upper" style="text-transform:uppercase">${TOKEN.toLowerCase()}</p>
    <iframe id="frame" style="width:420px;height:60px;border:0" srcdoc="<p id='deep' style='margin:4px;font:16px sans-serif'>in frame: ${TOKEN}</p>"></iframe>
    <x-closed id="closed" style="display:block;width:300px;height:24px"></x-closed>
    <canvas id="canvas" width="200" height="30"></canvas>
    <script>
      customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<span>${TOKEN}</span>'; } });
      const g = document.getElementById('canvas').getContext('2d'); g.font = '16px sans-serif'; g.fillText('${TOKEN}', 2, 20);
    </script>
  </body></html>`);
  await page.frameLocator('#frame').locator('#deep').waitFor();
}

describe('pixel privacy (re-audit R4)', () => {
  it('masks a secret in ordinary text, form values, expanded details, frames, split and transformed text and uninspectable content', async () => {
    const page = await browser.newPage();
    try {
      await leakPage(page);
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const id of ['ok', 'text', 'field', 'inside', 'split', 'upper', 'closed', 'canvas']) boxes[id] = (await page.locator(`#${id}`).boundingBox())!;
      boxes.deep = (await page.frameLocator('#frame').locator('#deep').boundingBox())!;

      // The leak is real: an ordinary capture (password-only masking, as before) shows the secret's pixels.
      const raw = await page.screenshot({ type: 'png', mask: [page.locator('input[type=password]')] });
      expect(maskedShare(raw, boxes.text!)).toBe(0);

      const shot = await safeScreenshot(page, { secrets: [TOKEN] });
      expect(shot.ok, shot.ok ? '' : shot.withheld).toBe(true);
      if (!shot.ok) return;
      for (const id of ['text', 'field', 'inside', 'split', 'upper', 'deep', 'closed', 'canvas']) expect(maskedShare(shot.png, boxes[id]!), id).toBe(1);
      // Positive control: non-sensitive evidence survives.
      expect(maskedShare(shot.png, boxes.ok!)).toBeLessThan(0.05);
      // Marks are removed afterwards; the page is unchanged.
      expect(await page.locator('[data-qa-sensitive]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('withholds the image when a secret appears during capture', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<p id="late">nothing yet</p>');
      // Capture takes the first mark pass, then the page changes before the verification pass.
      let calls = 0;
      const orig = page.screenshot.bind(page);
      page.screenshot = (async (o: Parameters<Page['screenshot']>[0]) => {
        const b = await orig(o);
        if (calls++ === 0) await page.evaluate((t) => (document.getElementById('late')!.textContent = t), TOKEN);
        return b;
      }) as Page['screenshot'];
      const shot = await safeScreenshot(page, { secrets: [TOKEN] });
      expect(shot).toMatchObject({ ok: false, withheld: expect.stringMatching(/appeared during capture/) });
    } finally {
      await page.close();
    }
  });

  it('publishes traces without image resources: a secret painted into an image is omitted, not trusted to byte redaction', async () => {
    const page = await browser.newPage();
    let png: Buffer;
    try {
      await leakPage(page);
      png = await page.screenshot({ type: 'png' });
    } finally {
      await page.close();
    }
    const zip = writeZip([
      { name: 'trace.trace', data: Buffer.from(`{"type":"action","value":"${TOKEN}"}\n`) },
      { name: 'resources/0a1b2c.png', data: png },
      { name: 'resources/page@1.jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
      { name: 'resources/style.css', data: Buffer.from('body{color:red}') },
    ]);
    const s = sanitizeTraceArchive(zip, [TOKEN]);
    expect(s.residualHits).toBe(0);
    expect(s.omittedImages.sort()).toEqual(['resources/0a1b2c.png', 'resources/page@1.jpeg']);
    const out = readZip(s.bytes);
    expect(out.map((e) => e.name).sort()).toEqual(['resources/style.css', 'trace.trace']);
    expect(out.find((e) => e.name === 'trace.trace')!.data.toString()).not.toContain(TOKEN);
    // The sanitized derivative is deterministic: its checksum can be recorded and re-verified.
    expect(createHash('sha256').update(sanitizeTraceArchive(zip, [TOKEN]).bytes).digest('hex')).toBe(createHash('sha256').update(s.bytes).digest('hex'));
  });

  it('every image a real attempt exports, and the image sent to System Two, masks a fixture secret shown on the page', async () => {
    const { app: a, fixtures } = await app(['note_delete_ignored']);
    a.control.credentialEcho = true;
    let s2Input: S2EscalationInput | undefined;
    try {
      // A regression attempt (milestone screenshots, a failure screenshot and a trace) ...
      const { report, runDir } = await runSuite({ scenarios: [await scenario('notes_crud')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login' });
      const c = report.cases[0]!;
      expect(c.verdict).toBe('FAIL');
      const images = c.artifacts.filter((x) => x.kind === 'screenshot');
      expect(images.map((x) => x.path.split('/').at(-1))).toEqual(expect.arrayContaining(['failure.png']));
      expect(images.length).toBeGreaterThanOrEqual(2);
      for (const img of images) {
        const png = await readFile(join(runDir, img.path));
        const { width, height } = PNG.sync.read(png);
        expect(maskedShare(png, { x: width - 360, y: height - 48, width: 360, height: 48 }), img.path).toBe(1);
        expect(maskedShare(png, { x: 0, y: 0, width: 300, height: 40 }), `${img.path} keeps the header`).toBeLessThan(0.05);
      }
      const trace = c.artifacts.find((x) => x.kind === 'trace')!;
      const entries = readZip(await readFile(join(runDir, trace.path)));
      expect(entries.length).toBeGreaterThan(1);
      expect(entries.filter((e) => /\.(png|jpe?g|webp)$/.test(e.name))).toEqual([]);

      // ... and an exploration attempt that escalates to a vision-capable System Two.
      const uncertain = new KeywordProvider((_req, q) => (q.id === 'op' ? ['CLICK'] : []));
      await runSuite({
        scenarios: [await scenario('checkout_exploration', 'exploration')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login',
        exploration: { s1: uncertain, model: 'offline', s2: { id: 'privacy-s2', supportsImages: true, async propose(input) { s2Input ??= input; return { kind: 'ABSTAIN', reason: 'probe complete', evidence_refs: [] }; } } },
      });
      expect(s2Input?.screenshot_png).toBeDefined();
      const s2 = s2Input!.screenshot_png!;
      const { width, height } = PNG.sync.read(s2);
      expect(maskedShare(s2, { x: width - 360, y: height - 48, width: 360, height: 48 })).toBe(1);
      expect(maskedShare(s2, { x: 0, y: 0, width: 300, height: 40 })).toBeLessThan(0.05);
    } finally {
      await a.close();
    }
  });
});
