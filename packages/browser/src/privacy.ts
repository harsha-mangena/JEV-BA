import type { Locator, Page } from '@playwright/test';

/**
 * Pixel-level privacy for every image the system captures (re-audit R4).
 *
 * Text redaction cannot make an image safe: a secret painted into pixels is
 * not the secret's bytes. So masking happens in the page, before capture:
 * every rendered element whose visible text or form value contains a
 * registered secret (in any frame and open shadow root, case-insensitively),
 * every declared sensitive selector, and everything whose content cannot be
 * inspected (cross-origin frames, custom elements without an open shadow
 * root, canvas/video/embedded objects by default) is marked and masked. The
 * page is re-checked after capture; if anything sensitive appeared that was
 * not masked, or a frame could not be inspected, the image is withheld.
 */
export const SENSITIVE_ATTR = 'data-qa-sensitive';
export const MASK_COLOR = '#FF00FF';
/** Masked unless a policy says otherwise: content the page cannot inspect for secrets. */
export const DEFAULT_SENSITIVE_SELECTORS = ['input[type=password]', 'canvas', 'video', 'embed', 'object'];

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
        ({ secrets, selectors, attr }) => {
          let newly = 0;
          let marked = 0;
          const mark = (e: Element) => {
            if (!e.hasAttribute(attr)) {
              e.setAttribute(attr, '');
              newly++;
            }
            marked++;
          };
          const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            const s = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const textOf = (e: Element): string => {
            if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) return `${e.value} ${e.placeholder}`;
            if (e instanceof HTMLSelectElement) return [...e.selectedOptions].map((x) => x.text).join(' ');
            return (e as HTMLElement).innerText ?? e.textContent ?? '';
          };
          const holds = (e: Element) => {
            const t = textOf(e).toLowerCase();
            return secrets.some((s) => t.includes(s));
          };
          const roots: Array<Document | ShadowRoot> = [document];
          for (let i = 0; i < roots.length; i++) {
            const root = roots[i]!;
            for (const sel of selectors) root.querySelectorAll(sel).forEach((e) => visible(e) && mark(e));
            for (const e of root.querySelectorAll('*')) {
              const sr = (e as HTMLElement).shadowRoot;
              if (sr) roots.push(sr);
              else if (e.tagName.includes('-') && customElements.get(e.tagName.toLowerCase()) && visible(e)) mark(e); // closed or unknown shadow content
              if (e instanceof HTMLIFrameElement || e instanceof HTMLFrameElement) {
                let readable = false;
                try {
                  readable = !!e.contentDocument;
                } catch {
                  readable = false;
                }
                if (!readable && visible(e)) mark(e); // content cannot be inspected: mask the whole frame
              }
            }
            // The deepest rendered element whose own text (or value) contains a secret is masked — including a
            // secret split across child elements, which only their common ancestor contains whole.
            for (const e of root.querySelectorAll('*')) {
              if (!visible(e) || !holds(e)) continue;
              const deeper = [...e.children].some((c) => visible(c) && holds(c)) || [...((e as HTMLElement).shadowRoot?.children ?? [])].some((c) => holds(c));
              if (!deeper) mark(e);
            }
          }
          return { newly, marked };
        },
        { secrets, selectors, attr: SENSITIVE_ATTR },
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

/** Locators for every marked element (one per frame), for Playwright's screenshot `mask`. */
export function sensitiveLocators(page: Page): Locator[] {
  return page.frames().map((f) => f.locator(`[${SENSITIVE_ATTR}]`));
}

export async function unmarkSensitive(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr)), SENSITIVE_ATTR).catch(() => undefined);
  }
}

export type SafeCapture = { ok: true; png: Buffer; masked: number } | { ok: false; withheld: string };

/**
 * Capture an image only if safe masking can be established: mark, capture
 * with every marked element (and any extra locators) masked, then re-check
 * that nothing sensitive became visible unmasked while capturing.
 */
export async function safeScreenshot(page: Page, o: PrivacyOptions & { fullPage?: boolean; extraMask?: Locator[]; stable?: boolean }): Promise<SafeCapture> {
  try {
    const before = await markSensitive(page, o);
    if (before.unsafe.length) return { ok: false, withheld: before.unsafe.join('; ') };
    const png = await page.screenshot({ type: 'png', fullPage: o.fullPage ?? false, mask: [...sensitiveLocators(page), ...(o.extraMask ?? [])], maskColor: MASK_COLOR, ...(o.stable ? { animations: 'disabled' as const, caret: 'hide' as const, scale: 'css' as const } : {}) });
    const after = await markSensitive(page, o);
    if (after.unsafe.length || after.newlyMarked > 0) return { ok: false, withheld: after.unsafe.length ? after.unsafe.join('; ') : `${after.newlyMarked} sensitive element(s) appeared during capture` };
    return { ok: true, png, masked: before.marked };
  } catch (e) {
    return { ok: false, withheld: `capture failed: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    await unmarkSensitive(page);
  }
}
