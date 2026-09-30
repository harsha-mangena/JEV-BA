import type { CDPSession, Locator, Page } from '@playwright/test';

/**
 * Pixel-level privacy for every image the system captures (re-audit R4,
 * review-3 N1, review-4 P4a/P4b).
 *
 * Text redaction cannot make an image safe: a secret painted into pixels is
 * not the secret's bytes. So the image is made safe in the page, before
 * capture, and what is published is established rather than estimated:
 *
 *  1. Detection marks every rendered element that shows a registered secret —
 *     in its text, its form value, or its CSS generated content (::before /
 *     ::after, including attr() values) — in every frame and open shadow root,
 *     case-insensitively, plus every declared sensitive selector and
 *     everything that cannot be inspected (cross-origin frames, shadow hosts
 *     without an open root, canvas, video, embedded objects).
 *  2. Masking covers each marked element's box, every text line box and every
 *     descendant box with opaque overlays; replaced elements and shadow hosts
 *     are masked by box. The masks show where content was redacted.
 *  3. Suppression: the paint of every marked element — its whole flat subtree
 *     and every pseudo-element — is switched off in a way author styles cannot
 *     override (inline and first-cascade-layer `!important`, in every tree
 *     scope, with a constructed-sheet fallback where a CSP blocks injected
 *     styles; no transitions or animations).
 *  4. Verification: immediately before and after the capture, every suppressed
 *     element and pseudo-element must compute `visibility: hidden` — including
 *     inside closed and browser-internal shadow trees, via the DevTools
 *     protocol — and the page is watched for changes to the suppressed content
 *     in between. The published image is that suppressed capture: sensitive
 *     paint that escaped the masks (overflow, transforms, positioned or
 *     generated content, low-contrast or translucent glyphs) is simply absent
 *     from it. No pixel-difference tolerance is involved.
 *  5. Anything unverified is retried a bounded number of times, then the image
 *     is withheld with the reason; a DOM re-scan after capture also withholds
 *     it when sensitive content appeared meanwhile.
 */
export const SENSITIVE_ATTR = 'data-qa-sensitive';
const OVERLAY_ATTR = 'data-qa-mask-overlay';
const BOX_ATTR = 'data-qa-mask-box';
/** Host of a closed shadow root: its content cannot be read, so it is treated as sensitive as a whole. */
const OPAQUE_ATTR = 'data-qa-opaque';
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
  // Closed shadow roots can hang off any element (a plain div or span too), and page script cannot see them:
  // `shadowRoot === null` does not mean "no shadow content". They are inventoried through the DevTools protocol.
  const opaque = await markOpaqueHosts(page);
  if (opaque === null) plan.unsafe.push('closed shadow roots cannot be inventoried in this browser, so sensitive content inside them cannot be ruled out');
  else {
    plan.newlyMarked += opaque.newly;
    plan.marked += opaque.newly;
    plan.unsafe.push(...opaque.unsafe);
  }
  return plan;
}

/**
 * Chromium: find every closed shadow root in the page — whatever its host's
 * tag, pre-existing, declarative or attached late, nested or not — in the main
 * document, same-process frames and each out-of-process frame, and mark the
 * outermost host reachable from page script as sensitive and opaque (its
 * content cannot be read, so it cannot be shown to be free of secrets).
 * Returns null when the browser has no DevTools protocol.
 */
async function markOpaqueHosts(page: Page): Promise<{ newly: number; unsafe: string[] } | null> {
  const targets: Array<{ label: string; open: () => Promise<CDPSession> }> = [{ label: 'the page', open: () => page.context().newCDPSession(page) }];
  for (const f of page.frames()) if (f !== page.mainFrame()) targets.push({ label: `frame ${f.url() || '(about:blank)'}`, open: () => page.context().newCDPSession(f) });
  let newly = 0;
  const unsafe: string[] = [];
  for (const [i, t] of targets.entries()) {
    let session: CDPSession;
    try {
      session = await t.open();
    } catch (e) {
      if (i === 0) return null; // no protocol at all (not Chromium)
      continue; // a frame that is part of its parent's process, already covered by the page's document
    }
    try {
      await session.send('DOM.enable');
      const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as unknown as { root: ProtocolNode };
      const hosts = new Set<number>();
      const walk = (n: ProtocolNode, sealed: boolean) => {
        for (const c of n.children ?? []) walk(c, sealed);
        for (const sr of n.shadowRoots ?? []) {
          if (sr.shadowRootType === 'closed' && !sealed) hosts.add(n.backendNodeId);
          walk(sr, sealed || sr.shadowRootType !== 'open');
        }
        if (n.contentDocument) walk(n.contentDocument, sealed);
      };
      walk(root, false);
      for (const backendNodeId of hosts) {
        const { object } = (await session.send('DOM.resolveNode', { backendNodeId })) as { object: { objectId?: string } };
        if (!object.objectId) throw new Error('a closed shadow root host could not be resolved');
        const r = (await session.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function (a, o) { this.setAttribute(o, ""); if (this.hasAttribute(a)) return 0; this.setAttribute(a, ""); return 1; }',
          arguments: [{ value: SENSITIVE_ATTR }, { value: OPAQUE_ATTR }],
          returnByValue: true,
        })) as { result: { value?: number } };
        newly += r.result.value ?? 0;
      }
    } catch (e) {
      unsafe.push(`closed shadow roots in ${t.label} could not be inventoried: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  return { newly, unsafe };
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
        ({ attr, overlayAttr, boxAttr, opaqueAttr, color, max, pad }) => {
          const BOXED = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'SVG', 'svg', 'BR', 'HR', 'PICTURE', 'METER', 'PROGRESS']);
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          const marked = roots.flatMap((root) => [...root.querySelectorAll(`[${attr}]`)]);
          let n = 0;
          for (const e of marked) {
            const inSvg = e instanceof SVGElement;
            const host = (e as HTMLElement).shadowRoot !== null || e.hasAttribute(opaqueAttr) || (e.tagName.includes('-') && customElements.get(e.tagName.toLowerCase()));
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
        { attr: SENSITIVE_ATTR, overlayAttr: OVERLAY_ATTR, boxAttr: BOX_ATTR, opaqueAttr: OPAQUE_ATTR, color: MASK_COLOR, max: MAX_OVERLAYS, pad: OVERLAY_PAD },
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

/** Locators for every element masked by box (one per frame), for Playwright's screenshot `mask`. */
export function sensitiveLocators(page: Page): Locator[] {
  return page.frames().map((f) => f.locator(`[${BOX_ATTR}]`));
}

export async function unmarkSensitive(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f
      .evaluate(
        ({ attrs, overlayAttr }) => {
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) {
            root.querySelectorAll(`[${overlayAttr}]`).forEach((e) => e.remove());
            for (const a of attrs) root.querySelectorAll(`[${a}]`).forEach((e) => e.removeAttribute(a));
          }
        },
        { attrs: [SENSITIVE_ATTR, BOX_ATTR, OPAQUE_ATTR], overlayAttr: OVERLAY_ATTR },
      )
      .catch(() => undefined);
  }
}


/** Our own attribute on every element whose paint is suppressed for the published capture. */
const HIDE_ATTR = 'data-qa-suppressed';
/** Pseudo-elements that can paint content of their own and are checked element by element. */
const PAINTING_PSEUDOS = ['::before', '::after', '::marker', '::first-letter', '::first-line', '::placeholder', '::file-selector-button'];
/** Suppression, verification and capture attempts before the image is withheld. */
const SUPPRESS_ATTEMPTS = 3;
/** Global (per frame) under which the page's original inline styles are kept while suppressed. */
const SAVED_KEY = '__qaPrivacySuppressed__';

/**
 * Suppress the paint of every marked element in every frame: the element, its
 * whole flat subtree (light descendants and open shadow trees) and every
 * pseudo-element of each, except our own overlays.
 *
 * Author styles are defeated rather than assumed away: each suppressed element
 * gets an inline `!important` declaration (the page's own inline style is kept
 * and restored afterwards), and each tree scope gets a stylesheet placed
 * *first*, whose rules sit in the first-declared cascade layer — for
 * `!important` declarations the first layer wins over every later layer and
 * over all unlayered author rules. Transitions and animations are switched off
 * for the same elements so neither can hold a visible value. None of this is
 * trusted: `verifySuppressed` checks the result.
 */
async function suppressMarked(page: Page): Promise<number> {
  let n = 0;
  for (const f of page.frames()) {
    const r = await f
      .evaluate(
        ({ attr, hideAttr, overlayAttr, id, key, pseudos }) => {
          const saved = new Map<Element, { attr: string | null; css: string }>();
          (globalThis as Record<string, unknown>)[key] = saved;
          const scopes = new Set<Document | ShadowRoot>();
          const hide = (e: Element) => {
            if (e.hasAttribute(overlayAttr) || e.hasAttribute(hideAttr)) return;
            saved.set(e, { attr: e.getAttribute('style'), css: (e as HTMLElement).style?.cssText ?? '' });
            e.setAttribute(hideAttr, '');
            const st = (e as HTMLElement | SVGElement).style;
            if (st) for (const [p, v] of [['visibility', 'hidden'], ['transition', 'none'], ['animation', 'none']] as const) st.setProperty(p, v, 'important');
            scopes.add(e.getRootNode() as Document | ShadowRoot);
            for (const c of e.children) hide(c);
            const sr = (e as HTMLElement).shadowRoot;
            if (sr) for (const c of sr.children) hide(c);
          };
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) root.querySelectorAll(`[${attr}]`).forEach(hide);
          const sel = [`[${hideAttr}]`, ...pseudos.map((p) => `[${hideAttr}]${p}`)].join(',');
          // The caret is hidden here too (rather than by the screenshot call, which rewrites style attributes of
          // form controls mid-capture and would look like a page change to the watch).
          const css = `@layer qa-privacy-suppress{${sel}{visibility:hidden!important;transition:none!important;animation:none!important}*{caret-color:transparent!important}}`;
          scopes.add(document);
          for (const scope of scopes) {
            scope.getElementById?.(id)?.remove();
            const s = document.createElement('style');
            s.id = id;
            s.textContent = css;
            if (scope instanceof Document) (scope.head ?? scope.documentElement).prepend(s);
            else scope.prepend(s);
            // A policy that blocks injected <style> (CSP style-src) does not block a constructed sheet.
            try {
              const sheet = new CSSStyleSheet();
              sheet.replaceSync(css);
              (sheet as CSSStyleSheet & { [k: string]: unknown })[id] = true;
              scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
            } catch {
              /* the <style> above, and verification, remain */
            }
          }
          return saved.size;
        },
        { attr: SENSITIVE_ATTR, hideAttr: HIDE_ATTR, overlayAttr: OVERLAY_ATTR, id: HIDE_STYLE_ID, key: SAVED_KEY, pseudos: PAINTING_PSEUDOS },
      )
      .catch((e: Error) => e);
    if (r instanceof Error) {
      if (!f.isDetached()) throw new Error(`sensitive content could not be suppressed in ${f === page.mainFrame() ? 'the page' : `frame ${f.url()}`}: ${r.message.split('\n')[0]}`);
      continue;
    }
    n += r;
  }
  return n;
}

/** Undo `suppressMarked`: the page's own inline styles come back exactly as they were. */
async function restoreMarked(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f
      .evaluate(
        ({ hideAttr, id, key }) => {
          const g = globalThis as Record<string, unknown>;
          // A capture that failed between starting and collecting the change watch leaves its observer behind.
          (g[`${key}watch`] as { obs: MutationObserver } | undefined)?.obs.disconnect();
          delete g[`${key}watch`];
          const saved = g[key] as Map<Element, { attr: string | null; css: string }> | undefined;
          delete g[key];
          for (const [e, { attr, css }] of saved ?? []) {
            // The attribute comes back byte for byte; where a CSP keeps an assigned style attribute from applying,
            // the declarations are restored through the CSSOM, which such a policy still allows.
            if (attr === null) e.removeAttribute('style');
            else {
              e.setAttribute('style', attr);
              const st = (e as HTMLElement).style;
              if (st && st.cssText !== css) st.cssText = css;
            }
            e.removeAttribute(hideAttr);
          }
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) {
            root.querySelectorAll(`style#${id}`).forEach((s) => s.remove());
            if (root.adoptedStyleSheets.some((x) => (x as CSSStyleSheet & { [k: string]: unknown })[id])) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((x) => !(x as CSSStyleSheet & { [k: string]: unknown })[id]);
            root.querySelectorAll(`[${hideAttr}]`).forEach((e) => e.removeAttribute(hideAttr));
          }
        },
        { hideAttr: HIDE_ATTR, id: HIDE_STYLE_ID, key: SAVED_KEY },
      )
      .catch(() => undefined);
  }
}

/**
 * Establish that nothing sensitive can paint: every suppressed element and
 * each of its painting pseudo-elements must compute `visibility: hidden` (or
 * `collapse`), and nothing new may have appeared inside a marked subtree.
 * Page script reaches light and open shadow trees; closed and browser-internal
 * (user-agent) shadow trees are checked through the DevTools protocol, and in
 * a browser without it a suppressed subtree that may contain one is reported
 * as unverifiable. Returns what could not be verified (empty → suppressed).
 */
async function verifySuppressed(page: Page): Promise<string[]> {
  const problems: string[] = [];
  let sealedCandidates = 0;
  for (const f of page.frames()) {
    const r = await f
      .evaluate(
        ({ attr, hideAttr, overlayAttr, pseudos }) => {
          const out: string[] = [];
          let sealed = 0;
          const name = (e: Element) => `<${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}>`;
          const hiddenValue = (v: string) => v === 'hidden' || v === 'collapse';
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
          for (const root of roots) {
            for (const m of root.querySelectorAll(`[${attr}]`)) if (!m.hasAttribute(hideAttr)) out.push(`${name(m)} was marked after suppression`);
            for (const e of root.querySelectorAll(`[${hideAttr}]`)) {
              if (!hiddenValue(getComputedStyle(e).visibility)) out.push(`${name(e)} is still visible`);
              for (const p of pseudos) {
                const cs = getComputedStyle(e, p);
                if (cs.length > 0 && !hiddenValue(cs.visibility)) out.push(`${name(e)}${p} is still visible`);
              }
              for (const c of [...e.children, ...((e as HTMLElement).shadowRoot?.children ?? [])]) {
                if (!c.hasAttribute(hideAttr) && !c.hasAttribute(overlayAttr)) out.push(`${name(c)} appeared inside sensitive content after suppression`);
              }
              // Content page script cannot inspect: browser-internal trees of form controls and media, and closed shadow roots.
              if (/^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO|DETAILS|METER|PROGRESS)$/.test(e.tagName) || (e.tagName.includes('-') && !(e as HTMLElement).shadowRoot)) sealed++;
            }
          }
          return { out, sealed };
        },
        { attr: SENSITIVE_ATTR, hideAttr: HIDE_ATTR, overlayAttr: OVERLAY_ATTR, pseudos: PAINTING_PSEUDOS },
      )
      .catch((e: Error) => e);
    if (r instanceof Error) {
      if (!f.isDetached()) problems.push(`suppression could not be verified in ${f === page.mainFrame() ? 'the page' : `frame ${f.url()}`}: ${r.message.split('\n')[0]}`);
      continue;
    }
    problems.push(...r.out);
    sealedCandidates += r.sealed;
  }
  const sealed = await verifySealedTrees(page);
  if (sealed === null) {
    if (sealedCandidates > 0) problems.push(`${sealedCandidates} suppressed element(s) may hold closed or browser-internal shadow content, which this browser cannot verify`);
  } else problems.push(...sealed);
  return problems;
}

interface ProtocolNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  pseudoType?: string;
  shadowRootType?: string;
  attributes?: string[];
  children?: ProtocolNode[];
  pseudoElements?: ProtocolNode[];
  shadowRoots?: ProtocolNode[];
  contentDocument?: ProtocolNode;
}

/**
 * Chromium: every element and pseudo-element inside a closed or user-agent
 * shadow tree of a suppressed element must compute hidden too (inner-scope
 * `!important` rules win over the outer page, so this is not implied by the
 * host being hidden). Null when the browser has no DevTools protocol.
 */
async function verifySealedTrees(page: Page): Promise<string[] | null> {
  let session;
  try {
    session = await page.context().newCDPSession(page);
  } catch {
    return null;
  }
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as unknown as { root: ProtocolNode };
    const targets: Array<{ node: ProtocolNode; label: string }> = [];
    const walk = (n: ProtocolNode, suppressed: boolean, sealed: boolean, path: string) => {
      const attrs = n.attributes ?? [];
      let own = suppressed;
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === HIDE_ATTR) own = true;
      const label = `${path} > ${n.pseudoType ? `::${n.pseudoType}` : n.nodeName.toLowerCase()}`;
      if (own && sealed && (n.nodeType === 1 || n.pseudoType)) targets.push({ node: n, label });
      for (const c of n.children ?? []) walk(c, own, sealed, label);
      for (const c of n.pseudoElements ?? []) walk(c, own, sealed, label);
      for (const c of n.shadowRoots ?? []) walk(c, own, sealed || c.shadowRootType !== 'open', `${label} #${c.shadowRootType ?? 'shadow'}`);
      // A frame's document is suppressed (or not) by its own markers: visibility does not cross documents.
      if (n.contentDocument) walk(n.contentDocument, false, false, label);
    };
    walk(root, false, false, 'document');
    const out: string[] = [];
    for (const t of targets) {
      const r = (await session.send('CSS.getComputedStyleForNode', { nodeId: t.node.nodeId }).catch(() => null)) as { computedStyle: Array<{ name: string; value: string }> } | null;
      const v = r?.computedStyle.find((x) => x.name === 'visibility')?.value;
      if (v !== 'hidden' && v !== 'collapse') out.push(`${t.label} is ${v ? `still ${v}` : 'unverifiable'}`);
    }
    return out;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Watch, during the capture, for changes that could make suppressed content
 * paint between the verification before and the one after it: anything added
 * to, or any attribute changed on, a suppressed subtree or its ancestors, and
 * removal of a suppression stylesheet. `collect` returns what changed.
 */
async function watchSuppressed(page: Page, collect: boolean): Promise<string[]> {
  const changes: string[] = [];
  for (const f of page.frames()) {
    const r = await f
      .evaluate(
        ({ collect, hideAttr, id, key }) => {
          const g = globalThis as Record<string, unknown>;
          const k = `${key}watch`;
          if (!collect) {
            const roots: Array<Document | ShadowRoot> = [document];
            for (let i = 0; i < roots.length; i++) for (const e of roots[i]!.querySelectorAll('*')) if ((e as HTMLElement).shadowRoot) roots.push((e as HTMLElement).shadowRoot!);
            const records: MutationRecord[] = [];
            const obs = new MutationObserver((rs) => records.push(...rs));
            for (const root of roots) obs.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
            g[k] = { obs, records };
            return [];
          }
          const w = g[k] as { obs: MutationObserver; records: MutationRecord[] } | undefined;
          delete g[k];
          if (!w) return ['the change watch was lost'];
          w.records.push(...w.obs.takeRecords());
          w.obs.disconnect();
          const suppressedTrees = [...document.querySelectorAll(`[${hideAttr}]`)];
          const relevant = (n: Node) => {
            const e = n instanceof Element ? n : n.parentElement;
            return !!e?.closest(`[${hideAttr}]`);
          };
          // Attributes of an ancestor can change which author rules apply inside; its other content cannot.
          const ancestor = (n: Node) => n instanceof Element && suppressedTrees.some((t) => n !== t && n.contains(t));
          const out: string[] = [];
          for (const m of w.records) {
            const removedOurs = [...m.removedNodes].some((x) => x instanceof HTMLStyleElement && x.id === id);
            if (removedOurs) out.push('a suppression stylesheet was removed');
            else if (m.type === 'attributes' && (relevant(m.target) || ancestor(m.target))) out.push(`attribute ${m.attributeName} changed on ${(m.target as Element).tagName.toLowerCase()}`);
            else if (m.type !== 'attributes' && relevant(m.target)) out.push(`content changed in ${m.target.nodeName.toLowerCase()}`);
          }
          return [...new Set(out)];
        },
        { collect, hideAttr: HIDE_ATTR, id: HIDE_STYLE_ID, key: SAVED_KEY },
      )
      .catch((e: Error) => (f.isDetached() ? [] : [`the change watch failed: ${e.message.split('\n')[0]}`]));
    changes.push(...r);
  }
  return changes;
}

export type SafeCapture = { ok: true; png: Buffer; masked: number } | { ok: false; withheld: string };

/**
 * Capture an image only if every sensitive element's paint can be shown to be
 * suppressed in it; otherwise withhold it and say why (see the module comment).
 */
export async function safeScreenshot(page: Page, o: PrivacyOptions & { fullPage?: boolean; extraMask?: Locator[]; stable?: boolean }): Promise<SafeCapture> {
  try {
    const before = await markSensitive(page, o);
    if (before.unsafe.length) return { ok: false, withheld: before.unsafe.join('; ') };
    const placed = await placeOverlays(page);
    if (placed.unsafe.length) return { ok: false, withheld: placed.unsafe.join('; ') };
    const shoot = (caret: 'hide' | 'initial') =>
      page.screenshot({ type: 'png', fullPage: o.fullPage ?? false, mask: [...sensitiveLocators(page), ...(o.extraMask ?? [])], maskColor: MASK_COLOR, animations: 'disabled', caret, ...(o.stable ? { scale: 'css' as const } : {}) });
    let png: Buffer | null = null;
    if (before.marked === 0) png = await shoot('hide');
    else {
      // The published image is the one taken while sensitive paint is suppressed — never an unsuppressed capture
      // judged "close enough". Suppression is verified immediately before and after the capture, and the page is
      // watched in between; anything unverified is retried a bounded number of times, then the image is withheld.
      let problem = '';
      for (let attempt = 0; attempt < SUPPRESS_ATTEMPTS && !png; attempt++) {
        try {
          await suppressMarked(page);
          const pre = await verifySuppressed(page);
          if (pre.length) {
            problem = pre.join('; ');
            continue;
          }
          await watchSuppressed(page, false);
          const candidate = await shoot('initial');
          const changed = await watchSuppressed(page, true);
          const post = await verifySuppressed(page);
          if (changed.length || post.length) {
            problem = [...changed, ...post].join('; ');
            continue;
          }
          png = candidate;
        } catch (e) {
          problem = `capture attempt failed: ${(e as Error).message.split('\n')[0]}`;
        } finally {
          await restoreMarked(page);
        }
      }
      if (!png) return { ok: false, withheld: `sensitive content could not be verified as suppressed in the capture: ${problem}` };
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
