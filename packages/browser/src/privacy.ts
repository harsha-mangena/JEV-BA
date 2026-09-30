import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Pixel-level privacy for every image the system captures (re-audit R4,
 * review-3 N1).
 *
 * Text redaction cannot make an image safe: a secret painted into pixels is
 * not the secret's bytes. So masking happens in the page, before capture, and
 * is then *verified on pixels*:
 *
 *  1. Detection marks every rendered element that shows a registered secret —
 *     in its text, its form value, or its CSS generated content (::before /
 *     ::after, including attr() values) — in every frame and open shadow root,
 *     case-insensitively, plus every declared sensitive selector and
 *     everything that cannot be inspected (cross-origin frames, shadow hosts
 *     without an open root, canvas, video, embedded objects).
 *  2. Masking covers each marked element's full painted extent, not just its
 *     box: opaque overlays are placed over the element box, every text line
 *     box and every descendant box (so overflowing, wrapped and positioned
 *     content is covered). Replaced elements and shadow hosts are masked by
 *     box.
 *  3. Verification captures the page twice — as is, and with every marked
 *     element (and all its descendants and generated content) made invisible.
 *     Any pixel that differs is sensitive paint the masks did not cover
 *     (overflow, transforms, positioned or generated content, animation), and
 *     the image is withheld. A DOM re-scan after capture also withholds the
 *     image when sensitive content appeared meanwhile.
 */
export const SENSITIVE_ATTR = 'data-qa-sensitive';
const OVERLAY_ATTR = 'data-qa-mask-overlay';
const BOX_ATTR = 'data-qa-mask-box';
const HIDE_STYLE_ID = 'qa-sensitive-hide';
export const MASK_COLOR = '#FF00FF';
/** Masked unless a policy says otherwise: content the page cannot inspect for secrets. */
export const DEFAULT_SENSITIVE_SELECTORS = ['input[type=password]', 'canvas', 'video', 'embed', 'object'];
/** More overlay rectangles than this for one image: masking cannot be established reliably, so withhold. */
const MAX_OVERLAYS = 2_000;
/** CSS pixels added around every overlay rectangle (glyph overhang and anti-aliasing reach past line boxes). */
const OVERLAY_PAD = 3;

export interface PrivacyOptions {
  /** Registered secret values (fixture secrets, session cookies, …). */
  secrets: readonly string[];
  /** Declared sensitive regions (CSS selectors), in addition to the defaults. */
  selectors?: readonly string[];
}

export interface MaskPlan {
  /** Elements marked in this pass that were not already marked. */
  newlyMarked: number;
  marked: number;
  /** Why safe masking could not be established (non-empty → withhold). */
  unsafe: string[];
}

/** Mark sensitive elements in every frame of the page (idempotent). */
export async function markSensitive(page: Page, o: PrivacyOptions): Promise<MaskPlan> {
  const secrets = [...new Set(o.secrets.filter((s) => s.length >= 4).map((s) => s.toLowerCase()))];
  const selectors = [...DEFAULT_SENSITIVE_SELECTORS, ...(o.selectors ?? [])];
  const plan: MaskPlan = { newlyMarked: 0, marked: 0, unsafe: [] };
  for (const frame of page.frames()) {
    const r = await frame
      .evaluate(
        ({ secrets, selectors, attr, overlayAttr }) => {
          let newly = 0;
          let marked = 0;
          const mark = (e: Element) => {
            if (!e.hasAttribute(attr)) {
              e.setAttribute(attr, '');
              newly++;
            }
            marked++;
          };
          const rendered = (e: Element) => {
            const s = getComputedStyle(e);
            if (s.display === 'none') return false;
            const r = e.getBoundingClientRect();
            return (r.width > 0 && r.height > 0) || s.display === 'contents' || e.getClientRects().length > 0 || (e as HTMLElement).innerText?.length > 0;
          };
          const has = (t: string | null | undefined) => {
            if (!t) return false;
            const l = t.toLowerCase();
            return secrets.some((s) => l.includes(s));
          };
          const textOf = (e: Element): string => {
            if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) return `${e.value} ${e.placeholder}`;
            if (e instanceof HTMLSelectElement) return [...e.selectedOptions].map((x) => x.text).join(' ');
            return (e as HTMLElement).innerText ?? e.textContent ?? '';
          };
          /** CSS generated content: the resolved `content` of ::before/::after (attr() is resolved), or any attribute feeding it. */
          const generated = (e: Element) => {
            for (const pseudo of ['::before', '::after', '::marker']) {
              const c = getComputedStyle(e, pseudo).content;
              if (!c || c === 'none' || c === 'normal') continue;
              if (has(c.replace(/\\(.)/g, '$1'))) return true;
              if ([...e.attributes].some((a) => has(a.value))) return true;
            }
            return false;
          };
          const holds = (e: Element) => has(textOf(e)) || generated(e);
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) {
            const root = roots[i]!;
            for (const sel of selectors) root.querySelectorAll(sel).forEach((e) => rendered(e) && mark(e));
            for (const e of root.querySelectorAll('*')) {
              if (e.hasAttribute(overlayAttr)) continue;
              const sr = (e as HTMLElement).shadowRoot;
              if (sr) roots.push(sr);
              else if (e.tagName.includes('-') && customElements.get(e.tagName.toLowerCase()) && rendered(e)) mark(e); // closed or unknown shadow content
              if (e instanceof HTMLIFrameElement || e instanceof HTMLFrameElement) {
                let readable = false;
                try {
                  readable = !!e.contentDocument;
                } catch {
                  readable = false;
                }
                if (!readable && rendered(e)) mark(e); // content cannot be inspected: mask the whole frame
              }
            }
            // The deepest rendered element whose own text, value or generated content shows a secret is marked —
            // including a secret split across child elements, which only their common ancestor contains whole.
            for (const e of root.querySelectorAll('*')) {
              if (e.hasAttribute(overlayAttr) || !rendered(e) || !holds(e)) continue;
              const deeper = [...e.children].some((c) => rendered(c) && holds(c)) || [...((e as HTMLElement).shadowRoot?.children ?? [])].some((c) => holds(c));
              if (!deeper || generated(e)) mark(e);
            }
          }
          return { newly, marked };
        },
        { secrets, selectors, attr: SENSITIVE_ATTR, overlayAttr: OVERLAY_ATTR },
      )
      .catch((e: Error) => e);
    if (r instanceof Error) {
      if (frame === page.mainFrame()) plan.unsafe.push(`the page could not be inspected for sensitive content: ${r.message.split('\n')[0]}`);
      else if (!frame.isDetached()) plan.unsafe.push(`frame ${frame.url() || '(about:blank)'} could not be inspected for sensitive content`);
      continue;
    }
    plan.newlyMarked += r.newly;
    plan.marked += r.marked;
  }
  return plan;
}

/**
 * Cover every marked element's painted extent: overlays (children of the
 * element, so they move with it) over its box, each text line box and each
 * descendant box; replaced elements and shadow hosts are flagged for box
 * masking instead. Returns the number of overlays, or an unsafe reason.
 */
async function placeOverlays(page: Page): Promise<{ overlays: number; unsafe: string[] }> {
  let overlays = 0;
  const unsafe: string[] = [];
  for (const frame of page.frames()) {
    const r = await frame
      .evaluate(
        ({ attr, overlayAttr, boxAttr, color, max, pad }) => {
          const BOXED = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'SVG', 'svg', 'BR', 'HR', 'PICTURE', 'METER', 'PROGRESS']);
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          const marked = roots.flatMap((root) => [...root.querySelectorAll(`[${attr}]`)]);
          let n = 0;
          for (const e of marked) {
            const inSvg = e instanceof SVGElement;
            const host = (e as HTMLElement).shadowRoot !== null || (e.tagName.includes('-') && customElements.get(e.tagName.toLowerCase()));
            if (BOXED.has(e.tagName) || inSvg || host) {
              (inSvg ? (e as SVGElement).ownerSVGElement ?? e : e).setAttribute(boxAttr, '');
              continue;
            }
            // Containing block of an absolutely positioned child of e.
            let cb: Element | null = e;
            while (cb && cb !== document.documentElement) {
              const s = getComputedStyle(cb);
              if (s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none' || /paint|layout|strict|content/.test(s.contain) || s.willChange.includes('transform')) break;
              cb = cb.parentElement;
            }
            const origin = (() => {
              if (!cb || cb === document.documentElement) return { x: -scrollX, y: -scrollY };
              const r = cb.getBoundingClientRect();
              return { x: r.left + cb.clientLeft - cb.scrollLeft, y: r.top + cb.clientTop - cb.scrollTop };
            })();
            const rects: DOMRect[] = [e.getBoundingClientRect()];
            const range = document.createRange();
            range.selectNodeContents(e);
            rects.push(...range.getClientRects());
            for (const d of e.querySelectorAll('*')) rects.push(d.getBoundingClientRect());
            for (const r of rects) {
              if (r.width <= 0 || r.height <= 0) continue;
              if (++n > max) return { n, over: true };
              const o = document.createElement('div');
              o.setAttribute(overlayAttr, '');
              o.style.cssText = `all:initial;position:absolute;display:block;box-sizing:border-box;margin:0;border:0;padding:0;left:${r.left - origin.x - pad}px;top:${r.top - origin.y - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;background:${color};opacity:1;visibility:visible;z-index:2147483647;pointer-events:none;transform:none`;
              e.appendChild(o);
            }
          }
          return { n, over: false };
        },
        { attr: SENSITIVE_ATTR, overlayAttr: OVERLAY_ATTR, boxAttr: BOX_ATTR, color: MASK_COLOR, max: MAX_OVERLAYS, pad: OVERLAY_PAD },
      )
      .catch((e: Error) => e);
    if (r instanceof Error) {
      if (!frame.isDetached()) unsafe.push(`masks could not be placed in ${frame === page.mainFrame() ? 'the page' : `frame ${frame.url()}`}: ${r.message.split('\n')[0]}`);
      continue;
    }
    overlays += r.n;
    if (r.over) unsafe.push(`more than ${MAX_OVERLAYS} sensitive regions`);
  }
  return { overlays, unsafe };
}

/** Make every marked element, its descendants and its generated content invisible (overlays stay), or undo it. */
async function hideMarked(page: Page, hide: boolean): Promise<void> {
  for (const f of page.frames()) {
    await f
      .evaluate(
        ({ hide, attr, overlayAttr, id }) => {
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) {
            const at = root instanceof Document ? root.head ?? root.documentElement : root;
            root.querySelector(`#${id}`)?.remove();
            if (!hide) continue;
            const s = document.createElement('style');
            s.id = id;
            s.textContent = `[${attr}],[${attr}] *,[${attr}]::before,[${attr}]::after,[${attr}] *::before,[${attr}] *::after{visibility:hidden!important}[${attr}] [${overlayAttr}]{visibility:visible!important}`;
            at.appendChild(s);
          }
        },
        { hide, attr: SENSITIVE_ATTR, overlayAttr: OVERLAY_ATTR, id: HIDE_STYLE_ID },
      )
      .catch(() => undefined);
  }
}

/** Locators for every element masked by box (one per frame), for Playwright's screenshot `mask`. */
export function sensitiveLocators(page: Page): Locator[] {
  return page.frames().map((f) => f.locator(`[${BOX_ATTR}]`));
}

export async function unmarkSensitive(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f
      .evaluate(
        ({ attrs, overlayAttr, id }) => {
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) {
            root.querySelectorAll(`[${overlayAttr}]`).forEach((e) => e.remove());
            root.querySelector(`#${id}`)?.remove();
            for (const a of attrs) root.querySelectorAll(`[${a}]`).forEach((e) => e.removeAttribute(a));
          }
        },
        { attrs: [SENSITIVE_ATTR, BOX_ATTR], overlayAttr: OVERLAY_ATTR, id: HIDE_STYLE_ID },
      )
      .catch(() => undefined);
  }
}

/**
 * Rasterization noise between two captures of the same page stays within a few
 * levels per channel (anti-aliasing of tiles repainted in a different order);
 * painted content — a glyph, a shadow, an image — differs far more.
 */
const NOISE_LEVELS = 12;
/** Paired captures tried before a mismatch is treated as a leak. */
const VERIFY_ATTEMPTS = 3;

/** Pixels that differ beyond rasterization noise between two captures (null when their geometry differs). */
function differingPixels(a: Buffer, b: Buffer): number | null {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return null;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.max(Math.abs(x.data[i]! - y.data[i]!), Math.abs(x.data[i + 1]! - y.data[i + 1]!), Math.abs(x.data[i + 2]! - y.data[i + 2]!), Math.abs(x.data[i + 3]! - y.data[i + 3]!));
    if (d > NOISE_LEVELS) n++;
  }
  return n;
}

export type SafeCapture = { ok: true; png: Buffer; masked: number } | { ok: false; withheld: string };

/**
 * Capture an image only if safe masking can be established and verified on
 * pixels (see the module comment); otherwise withhold it and say why.
 */
export async function safeScreenshot(page: Page, o: PrivacyOptions & { fullPage?: boolean; extraMask?: Locator[]; stable?: boolean }): Promise<SafeCapture> {
  try {
    const before = await markSensitive(page, o);
    if (before.unsafe.length) return { ok: false, withheld: before.unsafe.join('; ') };
    const placed = await placeOverlays(page);
    if (placed.unsafe.length) return { ok: false, withheld: placed.unsafe.join('; ') };
    const shoot = () =>
      page.screenshot({ type: 'png', fullPage: o.fullPage ?? false, mask: [...sensitiveLocators(page), ...(o.extraMask ?? [])], maskColor: MASK_COLOR, animations: 'disabled', caret: 'hide', ...(o.stable ? { scale: 'css' as const } : {}) });
    let png = await shoot();
    if (before.marked > 0) {
      // Pixel verification: with every sensitive element invisible, the image must be identical. A real leak is
      // deterministic; a page still settling (late layout, repaint noise) is not, so a mismatch is re-checked on a
      // fresh pair a bounded number of times before the image is withheld.
      let diff: number | null = null;
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
        if (attempt > 0) png = await shoot();
        await hideMarked(page, true);
        const hidden = await shoot();
        await hideMarked(page, false);
        diff = differingPixels(png, hidden);
        if (diff === 0) break;
      }
      if (diff === null) return { ok: false, withheld: 'the page changed size during capture' };
      if (diff > 0) return { ok: false, withheld: `${diff} pixel(s) of sensitive content are painted outside their masks (overflow, transform, positioned or generated content)` };
    }
    const after = await markSensitive(page, o);
    if (after.unsafe.length || after.newlyMarked > 0) return { ok: false, withheld: after.unsafe.length ? after.unsafe.join('; ') : `${after.newlyMarked} sensitive element(s) appeared during capture` };
    return { ok: true, png, masked: before.marked };
  } catch (e) {
    return { ok: false, withheld: `capture failed: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    await unmarkSensitive(page);
  }
}
