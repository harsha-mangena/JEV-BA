import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, MASK_COLOR, safeScreenshot } from '@qa/browser';
import { approveFromEvidence, FsBaselineStore, type BaselineKey } from '@qa/quality';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  it('withholds the image when the page keeps changing sensitive content during the suppressed capture (review-4)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<p id="x">token ${TOKEN}</p>`);
      const orig = page.screenshot.bind(page);
      let calls = 0;
      page.screenshot = (async (o: Parameters<Page['screenshot']>[0]) => {
        calls++;
        await page.evaluate(() => document.getElementById('x')!.setAttribute('class', `c${Math.random()}`));
        return orig(o);
      }) as Page['screenshot'];
      const shot = await safeScreenshot(page, { secrets: [TOKEN] });
      expect(shot).toMatchObject({ ok: false, withheld: expect.stringMatching(/could not be verified as suppressed.*attribute class changed/) });
      expect(calls, 'retried a bounded number of times').toBe(3);
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

  describe('painted extent and generated content (review-3 N1)', () => {
    /** Glyph-dark pixels (not background, not mask) inside a box. */
    function dark(png: Buffer, box: { x: number; y: number; width: number; height: number }): number {
      const img = PNG.sync.read(png);
      let n = 0;
      for (let y = Math.max(0, Math.ceil(box.y)); y < Math.min(img.height, Math.floor(box.y + box.height)); y++) {
        for (let x = Math.max(0, Math.ceil(box.x)); x < Math.min(img.width, Math.floor(box.x + box.width)); x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i]! < 110 && img.data[i + 1]! < 110 && img.data[i + 2]! < 110) n++;
        }
      }
      return n;
    }
    const cases: Array<[string, string]> = [
      ['::after literal content', `<style>#x::after{content:"code ${TOKEN}"}</style><p id="x" style="margin:20px">label</p>`],
      ['a positioned descendant far outside its parent', `<div id="x" style="position:relative;margin:20px;width:60px;height:24px"><span style="position:absolute;left:400px;top:0;white-space:nowrap">${TOKEN}</span></div>`],
      ['a rotated ancestor', `<div style="transform:rotate(12deg);transform-origin:0 0;margin:40px"><p id="x" style="white-space:nowrap">${TOKEN}</p></div>`],
      ['a far text-shadow (paint the masks cannot know about)', `<p id="x" style="margin:20px;text-shadow:420px 0 0 #000;white-space:nowrap">${TOKEN}</p>`],
    ];
    it.each(cases)('%s is masked or the image is withheld; nothing sensitive is visible in an accepted image', async (_name, html) => {
      const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
      try {
        await page.setContent(`<!doctype html><body style="margin:0;font:20px sans-serif;background:#fff;color:#000"><h1 id="ok" style="margin:8px;font-size:18px">Order summary</h1>${html}</body>`);
        const raw = await page.screenshot({ type: 'png' });
        const ok = (await page.locator('#ok').boundingBox())!;
        const shot = await safeScreenshot(page, { secrets: [TOKEN] });
        if (shot.ok) {
          // Everything except the positive-control heading: no glyph pixels at all once masked.
          expect(dark(shot.png, { x: 0, y: ok.y + ok.height + 2, width: 900, height: 300 })).toBe(0);
          expect(dark(shot.png, ok)).toBeGreaterThan(0);
        } else expect(shot.withheld).toMatch(/painted outside their masks|could not|appeared/);
        // Control: the leak is really there without masking.
        expect(dark(raw, { x: 0, y: ok.y + ok.height + 2, width: 900, height: 300 })).toBeGreaterThan(0);
      } finally {
        await page.close();
      }
    });

    describe('suppression cannot be defeated by the page (review-4 P4a/P4b)', () => {
      // Each secret paints outside every box the overlays cover, so only verified suppression keeps it out of the
      // published image. Leak = a pixel the secret paints (the page with vs. without it) reproduced exactly.
      const far = 'position:absolute;left:260px;top:0;white-space:nowrap';
      const host = (inner: string, style = '') => `<div id="x" data-v="${TOKEN}" style="position:relative;width:16px;height:24px;margin:20px;${style}">${inner}</div>`;
      const cases: Array<[string, string, 'accepted' | 'withheld']> = [
        ['an ID-specific !important visibility rule on a pseudo-element', `<style>#x::before{content:attr(data-v);${far};visibility:visible!important}</style>${host('')}`, 'accepted'],
        ['an inline !important visibility on the element', host(`<span style="${far}">${TOKEN}</span>`, 'visibility:visible!important'), 'accepted'],
        ['an !important visibility on a descendant class', `<style>.v{visibility:visible!important}</style>${host(`<span class="v" style="${far}">${TOKEN}</span>`)}`, 'accepted'],
        ['!important rules in the page\'s own cascade layer', `<style>@layer base{#x::after{content:attr(data-v);${far};visibility:visible!important}}</style>${host('')}`, 'accepted'],
        ['a visibility transition', `<style>#x,#x *{transition:visibility 60s}</style>${host(`<span style="${far}">${TOKEN}</span>`)}`, 'accepted'],
        ['low-contrast glyphs (rgb 245 on white)', `<style>#x::before{content:attr(data-v);${far};color:rgb(245,245,245)}</style>${host('')}`, 'accepted'],
        ['near-transparent glyphs (opacity 0.03)', `<style>#x::before{content:attr(data-v);${far};opacity:0.03}</style>${host('')}`, 'accepted'],
        ['a CSP that blocks injected style elements', `<meta http-equiv="Content-Security-Policy" content="style-src 'nonce-n1'"><style nonce="n1">#x::before{content:attr(data-v);${far};visibility:visible!important}</style>${host('')}`, 'accepted'],
        ['a closed shadow root that re-shows its content', `${host('')}<x-sealed id="s" style="display:block;position:relative;width:16px;height:24px;margin:20px"></x-sealed><script>customElements.define('x-sealed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<style>span{visibility:visible!important}</style><span style="${far}">${TOKEN}</span>'; } });</script>`, 'withheld'],
      ];
      it.each(cases)('%s: no secret pixel is published', async (_name, html, expected) => {
        const page = await browser.newPage({ viewport: { width: 900, height: 240 } });
        try {
          const doc = (body: string) => `<!doctype html><html><head></head><body style="margin:0;font:28px sans-serif;background:#fff;color:#000"><h1 id="ok" style="margin:8px;font-size:18px">Order summary</h1>${body}</body></html>`;
          const other = await browser.newPage({ viewport: { width: 900, height: 240 } });
          await other.setContent(doc(html.split(TOKEN).join('')));
          const blank = PNG.sync.read(await other.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
          await other.close();
          await page.setContent(doc(html));
          const styleBefore = await page.evaluate(() => document.getElementById('x')!.style.cssText);
          const raw = PNG.sync.read(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
          const glyph: number[] = [];
          for (let i = 0; i < raw.data.length; i += 4) if (raw.data[i] !== blank.data[i] || raw.data[i + 1] !== blank.data[i + 1] || raw.data[i + 2] !== blank.data[i + 2]) glyph.push(i);
          expect(glyph.length, 'control: the secret really paints in an ordinary capture').toBeGreaterThan(200);
          const ok = (await page.locator('#ok').boundingBox())!;
          const shot = await safeScreenshot(page, { secrets: [TOKEN] });
          if (shot.ok) {
            const out = PNG.sync.read(shot.png);
            const leaked = glyph.filter((i) => out.data[i] === raw.data[i] && out.data[i + 1] === raw.data[i + 1] && out.data[i + 2] === raw.data[i + 2]);
            expect(leaked.length, 'secret pixels reproduced in the published image').toBe(0);
            expect(dark(shot.png, ok), 'non-sensitive evidence survives').toBeGreaterThan(0);
          }
          expect(shot.ok ? 'accepted' : `withheld: ${shot.withheld}`).toMatch(expected === 'accepted' ? /^accepted$/ : /^withheld: .*could not be verified as suppressed/);
          // The page is left as it was: no marks, no suppression, no injected sheets.
          expect(await page.evaluate(() => document.querySelectorAll('[data-qa-sensitive],[data-qa-suppressed],[data-qa-mask-overlay],style#qa-sensitive-hide').length + document.adoptedStyleSheets.length)).toBe(0);
          expect(await page.evaluate(() => document.getElementById('x')!.style.cssText)).toBe(styleBefore);
        } finally {
          await page.close();
        }
      });
    });

    describe('closed shadow roots on any host (completion C1)', () => {
      // The secret lives only inside a closed shadow root, which page script cannot see from its host. An accepted
      // image must show, at every pixel the secret paints, exactly what the page shows without it (or the mask).
      const far = 'position:absolute;left:260px;top:0;white-space:nowrap';
      const serve = async (page: Page, pages: Record<string, string>) => {
        await page.route(/^http:\/\/(c1|x1)\.test\//, (route) => {
          const u = new URL(route.request().url());
          const body = pages[`${u.host}${u.pathname}`];
          return body === undefined ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'text/html', body });
        });
      };
      const doc = (body: string) => `<!doctype html><html><head></head><body style="margin:0;font:28px sans-serif;background:#fff;color:#000"><h1 id="ok" style="margin:8px;font-size:18px">Order summary</h1>${body}</body></html>`;
      // The secret is put in after load by the test harness, so it is never in markup, attributes or script text.
      type Inject = (page: Page, secret: string) => Promise<unknown>;
      const inFrame = (i: number, fn: (a: { far: string; t: string }) => void): Inject => (page, t) => page.frames()[i]!.evaluate(fn, { far, t });
      const box = 'position:relative;display:inline-block;margin:20px;width:16px;height:24px';
      const frameDoc = `<!doctype html><body style="margin:0;font:28px sans-serif;background:#fff;color:#000"><div id="h" style="${box}"></div></body>`;
      const cases: Array<[string, Record<string, string>, Inject, 'accepted' | 'withheld']> = [
        ['a div host', { 'c1.test/': doc(`<div id="h" style="${box}"></div>`) }, inFrame(0, ({ far, t }) => { const r = document.getElementById('h')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a span host', { 'c1.test/': doc(`<span id="h" style="${box}"></span>`) }, inFrame(0, ({ far, t }) => { const r = document.getElementById('h')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a declarative closed root', {}, async () => undefined, 'accepted'],
        ['a root nested in an open root', { 'c1.test/': doc('<div id="o" style="margin:20px"></div>') }, inFrame(0, ({ far, t }) => { const o = document.getElementById('o')!.attachShadow({ mode: 'open' }); o.innerHTML = '<div id="i" style="position:relative;width:16px;height:24px"></div>'; const r = o.getElementById('i')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a root nested in a closed root', { 'c1.test/': doc('<div id="o" style="margin:20px"></div>') }, inFrame(0, ({ far, t }) => { const o = document.getElementById('o')!.attachShadow({ mode: 'closed' }); o.innerHTML = '<div id="i" style="position:relative;width:16px;height:24px"></div>'; const r = o.getElementById('i')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a same-origin frame', { 'c1.test/': doc('<iframe src="/f" style="border:0;width:800px;height:60px"></iframe>'), 'c1.test/f': frameDoc }, inFrame(1, ({ far, t }) => { const r = document.getElementById('h')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a cross-origin (out-of-process) frame', { 'c1.test/': doc('<iframe src="http://x1.test/f" style="border:0;width:800px;height:60px"></iframe>'), 'x1.test/f': frameDoc }, inFrame(1, ({ far, t }) => { const r = document.getElementById('h')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'accepted'],
        ['a closed root that re-shows its content with !important', { 'c1.test/': doc(`<div id="h" style="${box}"></div>`) }, inFrame(0, ({ far, t }) => { const r = document.getElementById('h')!.attachShadow({ mode: 'closed' }); r.innerHTML = `<style>span{visibility:visible!important}</style><span style="${far}"></span>`; r.querySelector('span')!.textContent = t; }), 'withheld'],
      ];
      it.each(cases)('%s: no secret pixel is published', async (name, pages, inject, expected) => {
        const load = async (secret: string) => {
          const p = await browser.newPage({ viewport: { width: 900, height: 240 } });
          // Declarative shadow roots exist only as parsed markup; their template is gone from the DOM after parsing.
          await serve(p, name === 'a declarative closed root' ? { 'c1.test/': doc(`<div style="${box}"><template shadowrootmode="closed"><span style="${far}">${secret}</span></template></div>`) } : pages);
          await p.goto('http://c1.test/');
          await p.waitForLoadState('load');
          if (secret) await inject(p, secret);
          else await inject(p, '');
          return p;
        };
        const blankPage = await load('');
        const blank = PNG.sync.read(await blankPage.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
        await blankPage.close();
        const page = await load(TOKEN);
        try {
          const raw = PNG.sync.read(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
          const glyph: number[] = [];
          for (let i = 0; i < raw.data.length; i += 4) if (raw.data[i] !== blank.data[i] || raw.data[i + 1] !== blank.data[i + 1] || raw.data[i + 2] !== blank.data[i + 2]) glyph.push(i);
          expect(glyph.length, 'control: the secret really paints in an ordinary capture').toBeGreaterThan(200);
          expect(await page.evaluate((t) => document.documentElement.outerHTML.includes(t) || document.body.innerText.includes(t), TOKEN), 'the secret is not visible to page script').toBe(false);
          const shot = await safeScreenshot(page, { secrets: [TOKEN] });
          if (shot.ok) {
            const out = PNG.sync.read(shot.png);
            const bad = glyph.filter((i) => {
              const asBlank = out.data[i] === blank.data[i] && out.data[i + 1] === blank.data[i + 1] && out.data[i + 2] === blank.data[i + 2];
              const masked = Math.abs(out.data[i]! - R) < 8 && Math.abs(out.data[i + 1]! - G) < 8 && Math.abs(out.data[i + 2]! - B) < 8;
              return !asBlank && !masked;
            });
            expect(bad.length, 'secret pixels not replaced by the sanitized rendering').toBe(0);
          }
          expect(shot.ok ? 'accepted' : `withheld: ${shot.withheld}`).toMatch(expected === 'accepted' ? /^accepted$/ : /^withheld: .*could not be verified as suppressed/);
          expect(await page.evaluate(() => document.querySelectorAll('[data-qa-sensitive],[data-qa-opaque],[data-qa-suppressed],[data-qa-mask-overlay],style#qa-sensitive-hide').length)).toBe(0);
        } finally {
          await page.close();
        }
      });

      it('a host that appears after navigation is found on the new document', async () => {
        const page = await browser.newPage({ viewport: { width: 900, height: 240 } });
        try {
          await serve(page, { 'c1.test/': doc('<p>first page</p>'), 'c1.test/next': doc(`<div id="h" style="position:relative;margin:20px;width:16px;height:24px"></div><script>setTimeout(() => document.getElementById('h').attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(`<span style="${far}">${TOKEN}</span>`)}, 50)</script>`) });
          await page.goto('http://c1.test/');
          expect((await safeScreenshot(page, { secrets: [TOKEN] })).ok).toBe(true);
          await page.goto('http://c1.test/next');
          await page.waitForTimeout(200);
          const shot = await safeScreenshot(page, { secrets: [TOKEN] });
          expect(shot.ok && shot.masked, 'the late closed-root host is marked').toBeGreaterThan(0);
        } finally {
          await page.close();
        }
      });
    });

    it('a failed capture attempt leaves no marks, sheets, observers or changed markup behind (completion C1)', async () => {
      const page = await browser.newPage();
      try {
        await page.addInitScript(() => {
          const Orig = window.MutationObserver;
          const live = new Set<MutationObserver>();
          (window as unknown as { __live: Set<MutationObserver> }).__live = live;
          window.MutationObserver = class extends Orig {
            override observe(t: Node, o?: MutationObserverInit) { live.add(this); return super.observe(t, o); }
            override disconnect() { live.delete(this); return super.disconnect(); }
          };
        });
        await page.goto('data:text/html,<p id="x" style="color:red;width:300px">token SECRET_PLACEHOLDER</p><div id="h"></div>'.replace('SECRET_PLACEHOLDER', TOKEN));
        await page.evaluate(() => document.getElementById('h')!.attachShadow({ mode: 'closed' }).innerHTML = '<b>opaque</b>');
        const before = await page.evaluate(() => document.documentElement.outerHTML);
        const orig = page.screenshot.bind(page);
        let calls = 0;
        page.screenshot = (async (o: Parameters<Page['screenshot']>[0]) => {
          if (calls++ === 0) throw new Error('injected capture failure');
          return orig(o);
        }) as Page['screenshot'];
        const shot = await safeScreenshot(page, { secrets: [TOKEN] });
        expect(shot.ok, shot.ok ? '' : shot.withheld).toBe(true);
        expect(calls).toBe(2);
        expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
        expect(await page.evaluate(() => ({ live: (window as unknown as { __live: Set<unknown> }).__live.size, sheets: document.adoptedStyleSheets.length, keys: Object.keys(globalThis).filter((k) => k.startsWith('__qaPrivacy')) }))).toEqual({ live: 0, sheets: 0, keys: [] });
      } finally {
        await page.close();
      }
    });

    it.each([['generated'], ['overflow'], ['closed']] as const)('a fixture secret shown as %s content is masked in evidence, visual candidates and diffs, and the S2 image', async (mode) => {
      const band = (png: Buffer) => {
        const { width, height } = PNG.sync.read(png);
        return dark(png, { x: width - 360, y: height - 48, width: 360, height: 48 });
      };
      const { app: a, fixtures } = await app(['note_delete_ignored']);
      a.control.credentialEcho = mode;
      try {
        // Evidence screenshots (milestones and failure).
        const r1 = await runSuite({ scenarios: [await scenario('notes_crud')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login' });
        const shots = r1.report.cases[0]!.artifacts.filter((x) => x.kind === 'screenshot');
        const events = await readFile(join(r1.runDir, r1.report.cases[0]!.artifacts.find((x) => x.kind === 'events')!.path), 'utf8');
        expect(shots.length + (events.match(/withheld/g)?.length ?? 0)).toBeGreaterThanOrEqual(2);
        for (const s of shots) expect(band(await readFile(join(r1.runDir, s.path))), s.path).toBe(0);

        // Visual checkpoint candidate, then (after approval) a diff against a restyled header.
        const store = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-priv-bl-')));
        const cart = await scenario('cart_quality');
        const first = await runSuite({ scenarios: [cart], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', quality: { baselines: store } });
        const va = first.report.cases[0]!.assertions.find((x) => x.type === 'visual_match')!;
        expect(va.status, va.message ?? '').toBe('needs_review');
        const [, path, sha] = /artifact: (\S+)#sha256=([0-9a-f]{64})/.exec(va.message!)!;
        expect(band(await readFile(join(first.runDir, path!)))).toBe(0);
        await approveFromEvidence(store, (va.expected as { key: BaselineKey }).key, join(first.runDir, path!), sha!, { approved_by: 'reviewer@example.test', commit_sha: 'a'.repeat(40), source: 'test', expected_version: 0 });
        a.defects.add('header_restyled');
        const second = await runSuite({ scenarios: [cart], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', quality: { baselines: store } });
        const images = second.report.cases[0]!.artifacts.filter((x) => x.kind === 'visual_candidate' || x.kind === 'visual_diff');
        const vb = second.report.cases[0]!.assertions.find((x) => x.type === 'visual_match')!;
        expect(images.map((x) => x.kind).sort(), vb.message ?? vb.status).toEqual(['visual_candidate', 'visual_diff']);
        for (const img of images) expect(band(await readFile(join(second.runDir, img.path))), img.path).toBe(0);
        a.defects.delete('header_restyled');

        // The image a vision-capable System Two receives.
        let s2: S2EscalationInput | undefined;
        const uncertain = new KeywordProvider((_req, q) => (q.id === 'op' ? ['CLICK'] : []));
        await runSuite({
          scenarios: [await scenario('checkout_exploration', 'exploration')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login',
          exploration: { s1: uncertain, model: 'offline', s2: { id: 'privacy-s2', supportsImages: true, async propose(input) { s2 ??= input; return { kind: 'ABSTAIN', reason: 'probe complete', evidence_refs: [] }; } } },
        });
        expect(s2).toBeDefined();
        if (s2!.screenshot_png) expect(band(s2!.screenshot_png)).toBe(0);
      } finally {
        await a.close();
      }
    });
  });
});
