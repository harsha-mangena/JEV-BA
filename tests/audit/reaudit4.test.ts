// Fourth-review probes (P4a–P4c, review of merged PR #4 at 333f23c). Assertions
// describe the required safe behaviour and use only APIs present at the
// reviewed revision, so the same file reproduces each finding there and guards
// the fix. All secrets are synthetic; the cgroup probe never joins or kills a
// process.
import { mkdtemp, readdir, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchBrowser, safeScreenshot } from '@qa/browser';
import { createSandboxCgroup } from '@qa/compiler';

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });
const evidence = (id: string, data: unknown) => console.log(`REAUDIT4 ${id} ${JSON.stringify(data)}`);

// ---------- P4a / P4b: generated content painted outside its host box ----------

const TOKEN = 'tok-7c2f-SECRET-41ad';

/**
 * Render the layout, take a raw (unprotected) capture to find every pixel the
 * secret paints, then check the protected capture: an accepted image must not
 * reproduce any of those pixels.
 */
async function leakedGlyphPixels(pseudoCss: string) {
  const p: Page = await browser.newPage({ viewport: { width: 900, height: 200 } });
  try {
    const html = (value: string) =>
      `<!doctype html><body style="margin:0;font:28px sans-serif;background:#fff;color:#000"><style>#value::before{content:attr(data-value);position:absolute;left:220px;top:0;white-space:nowrap;${pseudoCss}}</style><div id="value" data-value="${value}" style="position:relative;width:16px;height:16px;margin:40px 20px"></div></body>`;
    // Glyph pixels: where the page with the secret differs from the same page without it.
    await p.setContent(html(''));
    const blank = PNG.sync.read(await p.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
    await p.setContent(html(TOKEN));
    const raw = PNG.sync.read(await p.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
    const glyph: number[] = [];
    for (let i = 0; i < raw.data.length; i += 4) {
      if (raw.data[i] !== blank.data[i] || raw.data[i + 1] !== blank.data[i + 1] || raw.data[i + 2] !== blank.data[i + 2]) glyph.push(i);
    }
    const shot = await safeScreenshot(p, { secrets: [TOKEN] });
    if (!shot.ok) return { glyph_pixels: glyph.length, ok: false as const, withheld: shot.withheld, leaked: 0 };
    const out = PNG.sync.read(shot.png);
    const leaked = glyph.filter((i) => out.data[i] === raw.data[i] && out.data[i + 1] === raw.data[i + 1] && out.data[i + 2] === raw.data[i + 2]).length;
    return { glyph_pixels: glyph.length, ok: true as const, masked: shot.masked, leaked };
  } finally {
    await p.close();
  }
}

it('P4 control: positioned black generated content outside the host box is not published', async () => {
  const r = await leakedGlyphPixels('');
  evidence('P4-control', r);
  expect(r.glyph_pixels).toBeGreaterThan(500);
  expect(r.leaked, 'secret glyph pixels must not survive into an accepted image').toBe(0);
});

it('P4a: an author !important visibility rule on the pseudo-element cannot defeat the privacy verification', async () => {
  const r = await leakedGlyphPixels('visibility:visible!important');
  evidence('P4a', r);
  expect(r.glyph_pixels).toBeGreaterThan(500);
  expect(r.leaked, 'secret glyph pixels must not survive into an accepted image').toBe(0);
});

it('P4b: low-contrast secret glyphs are not accepted as rasterization noise', async () => {
  const r = await leakedGlyphPixels('color:rgb(245,245,245)');
  evidence('P4b', r);
  expect(r.glyph_pixels).toBeGreaterThan(500);
  expect(r.leaked, 'low-contrast secret glyph pixels must not survive into an accepted image').toBe(0);
});

// ---------- P4c: a plain directory must not be accepted as an enforced cgroup ----------

const CGROUP_MAGIC = new Set([0x27e0eb, 0x63677270]);

it('P4c: an ordinary writable directory named as the delegated cgroup parent is rejected (fail closed)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qa-fake-cgroup-'));
  try {
    const fsType = (await statfs(dir)).type;
    expect(CGROUP_MAGIC.has(fsType), 'the probe directory must not be on a cgroup filesystem').toBe(false);
    const cg = await createSandboxCgroup({ memoryBytes: 64 * 1024 * 1024, pids: 64 }, { QA_SANDBOX_CGROUP: dir });
    const accepted = !('unavailable' in cg);
    evidence('P4c', { fs_type: `0x${fsType.toString(16)}`, accepted, ...(accepted ? { claimed_version: cg.version, created: await readdir(dir) } : { unavailable: cg.unavailable }) });
    if (accepted) await rm(cg.path, { recursive: true, force: true });
    expect(accepted, 'an ordinary directory cannot enforce a memory limit').toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
