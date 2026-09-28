import type { Locator, Page } from '@playwright/test';
import type { ControlIdentity } from '@qa/contracts';

/**
 * One in-page implementation of control identity (role, accessible name, form
 * and section), shared by observation (exploration) and by the regression
 * driver's pre-dispatch authorization, so both drivers bind the same control
 * to the same contract entry. Plain JS source: it is evaluated in the page.
 */
export const IDENTIFY_SOURCE = String.raw`(() => {
  if (window.__qaIdentify) return;
  const clip = (s) => (s.length > 120 ? s.slice(0, 120) + '…' : s);
  const norm = (s) => clip(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  const byIds = (ids) => norm(String(ids || '').split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' '));
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = el.type;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'generic';
  };
  const name = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return byIds(labelled);
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
      if (norm(labels)) return norm(labels);
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return norm(el.value);
      return norm(el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    return norm(el.innerText || el.textContent || el.getAttribute('title'));
  };
  const scopeName = (c) => {
    if (!c) return undefined;
    const n = c.getAttribute('aria-label') || (c.getAttribute('aria-labelledby') ? byIds(c.getAttribute('aria-labelledby')) : (c.querySelector('h1,h2,h3,legend') || {}).textContent);
    return norm(n) || c.tagName.toLowerCase();
  };
  window.__qaIdentify = (el) => ({
    role: role(el),
    name: name(el),
    tag: el.tagName.toLowerCase(),
    form: el.form ? scopeName(el.form) : scopeName(el.closest('form')),
    section: scopeName(el.closest('section,dialog[open],[role=dialog],[role=region],nav,aside,fieldset')),
  });
})()`;

export async function installIdentify(page: Page): Promise<void> {
  await page.evaluate(IDENTIFY_SOURCE);
}

type Identified = ControlIdentity & { tag: string };

/** Identity of the single element a locator resolves to. */
export async function identifyLocator(page: Page, locator: Locator): Promise<Identified> {
  await installIdentify(page);
  return locator.evaluate((el) => (window as unknown as { __qaIdentify(e: Element): Identified }).__qaIdentify(el));
}

/** Identity of the currently focused control (Enter/Space activate it), or null. */
export async function identifyFocused(page: Page): Promise<Identified | null> {
  await installIdentify(page);
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return (window as unknown as { __qaIdentify(e: Element): Identified }).__qaIdentify(el);
  });
}
