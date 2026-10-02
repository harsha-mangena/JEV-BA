// Completion-plan probes C1 and C2 (source-review findings on 524a8e9, awaiting
// runtime reproduction). Assertions state the required safe behaviour and use
// only APIs present at 524a8e9, so the same file reproduces each finding there
// and guards the fix. Secrets are synthetic. C2 injects faults into the host's
// cgroup control-file I/O; the kernel is never asked to enforce anything odd.
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Control files whose I/O the C2 probes perturb (host side only). */
const faults = vi.hoisted(() => ({ denyWrite: null as RegExp | null, readOverride: null as { match: RegExp; value: string } | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const deny = (p: unknown) => {
    if (faults.denyWrite && typeof p === 'string' && faults.denyWrite.test(p)) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
  };
  const mod = {
    ...fs,
    open: (async (p: Parameters<typeof fs.open>[0], flags?: Parameters<typeof fs.open>[1], ...rest: unknown[]) => {
      if (flags && String(flags) !== 'r') deny(p);
      return (fs.open as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as typeof fs.open,
    writeFile: (async (p: Parameters<typeof fs.writeFile>[0], ...rest: unknown[]) => {
      deny(p);
      return (fs.writeFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFile,
    readFile: (async (p: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      if (faults.readOverride && typeof p === 'string' && faults.readOverride.match.test(p)) return rest[0] ? `${faults.readOverride.value}\n` : Buffer.from(`${faults.readOverride.value}\n`);
      return (fs.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFile,
  };
  return { ...mod, default: mod };
});

const { launchBrowser, MASK_COLOR, safeScreenshot } = await import('@qa/browser');
const { createSandboxCgroup, runSandboxed } = await import('@qa/compiler');

const evidence = (id: string, data: unknown) => console.log(`COMPLETION ${id} ${JSON.stringify(data)}`);
beforeEach(() => {
  faults.denyWrite = null;
  faults.readOverride = null;
});

// ---------- C1: closed shadow roots on ordinary HTML hosts ----------

const TOKEN = 'tok-c1c1-SECRET-5e6f';
let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [MR, MG, MB] = hex(MASK_COLOR);

/**
 * Page with an empty visible host (div or span) and, after `attach`, a closed
 * shadow root holding the secret. Glyph pixels are found by comparing the page
 * with and without the secret; an accepted image must show, at each of them,
 * exactly what the page shows without the secret (or the mask colour) — so a
 * recoloured or shifted secret cannot pass.
 */
async function closedRootCase(attach: (p: Page, secret: string) => Promise<void>, body: string, opts: { selectors?: string[] } = {}) {
  const shoot = async (secret: string) => {
    const p = await browser.newPage({ viewport: { width: 900, height: 200 } });
    await p.setContent(`<!doctype html><body style="margin:0;font:28px sans-serif;background:#fff;color:#000"><h1 id="ok" style="margin:8px;font-size:18px">Order summary</h1>${body}</body>`);
    await attach(p, secret);
    return p;
  };
  const blankPage = await shoot('');
  const blank = PNG.sync.read(await blankPage.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
  await blankPage.close();
  const p = await shoot(TOKEN);
  try {
    const raw = PNG.sync.read(await p.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
    const glyph: number[] = [];
    for (let i = 0; i < raw.data.length; i += 4) if (raw.data[i] !== blank.data[i] || raw.data[i + 1] !== blank.data[i + 1] || raw.data[i + 2] !== blank.data[i + 2]) glyph.push(i);
    const lightDomHasSecret = await p.evaluate((t) => document.documentElement.outerHTML.includes(t), TOKEN);
    const shot = await safeScreenshot(p, { secrets: [TOKEN], selectors: opts.selectors });
    let unsanitized = 0;
    if (shot.ok) {
      const out = PNG.sync.read(shot.png);
      for (const i of glyph) {
        const same = (img: PNG) => out.data[i] === img.data[i] && out.data[i + 1] === img.data[i + 1] && out.data[i + 2] === img.data[i + 2];
        const mask = Math.abs(out.data[i]! - MR!) < 8 && Math.abs(out.data[i + 1]! - MG!) < 8 && Math.abs(out.data[i + 2]! - MB!) < 8;
        if (!same(blank) && !mask) unsanitized++;
      }
    }
    return { glyph_pixels: glyph.length, light_dom_has_secret: lightDomHasSecret, ok: shot.ok, ...(shot.ok ? { masked: shot.masked } : { withheld: shot.withheld }), unsanitized_glyph_pixels: unsanitized };
  } finally {
    await p.close();
  }
}

const closedOn = (sel: string) => async (p: Page, secret: string) =>
  p.evaluate(
    ([s, t]) => {
      const root = document.querySelector(s!)!.attachShadow({ mode: 'closed' });
      root.innerHTML = `<span style="white-space:nowrap">${t}</span>`;
    },
    [sel, secret],
  );

describe('C1: a secret inside a closed shadow root on an ordinary HTML host', () => {
  for (const tag of ['div', 'span']) {
    it(`${tag} host: the image is withheld or the secret's pixels are sanitized`, async () => {
      const r = await closedRootCase(closedOn('#host'), `<${tag} id="host" style="display:inline-block;margin:20px;min-width:10px;min-height:10px"></${tag}>`);
      evidence(`C1-${tag}`, r);
      expect(r.glyph_pixels, 'control: the secret really paints').toBeGreaterThan(200);
      expect(r.light_dom_has_secret, 'the secret is only inside the closed root').toBe(false);
      expect(r.unsanitized_glyph_pixels, 'secret pixels in an accepted image').toBe(0);
    });
  }

  it('positive control: the same host declared as a sensitive selector is sanitized', async () => {
    const r = await closedRootCase(closedOn('#host'), `<div id="host" style="display:inline-block;margin:20px;min-width:10px;min-height:10px"></div>`, { selectors: ['#host'] });
    evidence('C1-selector-control', r);
    expect(r.glyph_pixels).toBeGreaterThan(200);
    expect(r.unsanitized_glyph_pixels).toBe(0);
  });

  it('positive control: a registered custom-element host (already covered) is sanitized', async () => {
    const r = await closedRootCase(
      async (p, secret) => p.evaluate((t) => customElements.define('x-host', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = `<span style="white-space:nowrap">${t}</span>`; } }), secret),
      `<x-host id="host" style="display:inline-block;margin:20px;min-width:10px;min-height:10px"></x-host>`,
    );
    evidence('C1-custom-element-control', r);
    expect(r.glyph_pixels).toBeGreaterThan(200);
    expect(r.unsanitized_glyph_pixels).toBe(0);
  });
});

// ---------- C2: cgroup v1 combined memory-and-swap limit ----------

const WORK = join(import.meta.dirname, '../../.qa-work/completion-c2');
async function dispatch(name: string) {
  const workDir = join(WORK, name);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const r = await runSandboxed({ command: [process.execPath, '-e', `require('fs').writeFileSync('/sandbox/work/ran', '1')`], workDir, timeoutMs: 30_000, limits: { memoryBytes: 128 * 1024 * 1024 } });
  const ran = await stat(join(workDir, 'ran')).then(() => true, () => false);
  return { status: r.status, ran, stderr: r.stderr.slice(0, 300) };
}

/** The control that bounds swap on this host: the v1 combined limit, or the v2 swap limit. */
async function swapControl() {
  const cg = await createSandboxCgroup({ memoryBytes: 128 * 1024 * 1024, pids: 64 });
  if ('unavailable' in cg) throw new Error(`no valid cgroup on this host: ${cg.unavailable}`);
  await cg.destroy();
  return cg.version === 1 ? { version: 1, file: /memory\.memsw\.limit_in_bytes$/ } : { version: 2, file: /memory\.swap\.max$/ };
}

describe('C2: the swap bound of the memory limit (v1: memory.memsw.limit_in_bytes)', () => {
  it('control: on this host a valid cgroup is created and the program runs', async () => {
    const { version } = await swapControl();
    const r = await dispatch('control');
    evidence('C2-control', { version, ...r });
    expect(r.status).toBe('exited');
    expect(r.ran).toBe(true);
  });

  it('a denied write of the swap bound refuses execution (fail closed)', async () => {
    const { version, file } = await swapControl();
    faults.denyWrite = file;
    const r = await dispatch('swap-denied');
    evidence('C2-swap-write-denied', { version, control: file.source, ...r });
    expect(r.ran, 'the program must not run when the swap bound could not be set').toBe(false);
    expect(r.status).toBe('unavailable');
  });

  it('a swap bound that reads back weaker than requested refuses execution', async () => {
    const { version, file } = await swapControl();
    faults.readOverride = { match: file, value: version === 1 ? '9223372036854771712' : 'max' };
    const r = await dispatch('swap-mismatch');
    evidence('C2-swap-readback-mismatch', { version, control: file.source, ...r });
    expect(r.ran, 'the program must not run under an unverified swap bound').toBe(false);
    expect(r.status).toBe('unavailable');
  });
});
