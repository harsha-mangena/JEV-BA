import { ensureEvalShim } from '@qa/browser';
import type { Page } from '@playwright/test';

export type LayoutCheck = 'horizontal_overflow' | 'overlapping_controls' | 'obscured_controls' | 'clipped_text';

export interface LayoutIssue {
  check: LayoutCheck;
  element: string;
  detail: string;
}

/**
 * Code-based geometry checks. They report concrete elements and measurements
 * rather than a score, so a finding can be verified by hand.
 */
export async function checkLayout(page: Page, checks: LayoutCheck[]): Promise<LayoutIssue[]> {
  await ensureEvalShim(page);
  return page.evaluate(async (wanted) => {
    const issues: Array<{ check: LayoutCheck; element: string; detail: string }> = [];
    const describe = (el: Element) => {
      const id = el.getAttribute('data-testid') ?? el.id;
      const name = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${name ? ` "${name}"` : ''}`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('dialog:not([open]),[hidden]');
    };
    const controls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]')].filter(visible);

    if (wanted.includes('horizontal_overflow')) {
      const width = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > width + 1) {
        const offenders = [...document.body.querySelectorAll('*')]
          .filter((el) => visible(el) && el.getBoundingClientRect().right > width + 1)
          .filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= width + 1 || el.parentElement === document.body)
          .slice(0, 5);
        issues.push({ check: 'horizontal_overflow', element: offenders.map(describe).join(', ') || 'document', detail: `page scrolls horizontally: ${document.documentElement.scrollWidth}px content in ${width}px viewport` });
      }
    }
    if (wanted.includes('overlapping_controls')) {
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i]!, b = controls[j]!;
          if (a.contains(b) || b.contains(a)) continue;
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w <= 0 || h <= 0) continue;
          const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
          if ((w * h) / smaller > 0.25) issues.push({ check: 'overlapping_controls', element: `${describe(a)} / ${describe(b)}`, detail: `${Math.round(((w * h) / smaller) * 100)}% overlap` });
        }
      }
    }
    if (wanted.includes('obscured_controls')) {
      const y0 = scrollY;
      for (const el of controls) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const top = document.elementFromPoint(cx, cy);
        if (!top || top === el || el.contains(top) || top.contains(el)) continue;
        const labels = [...((el as HTMLInputElement).labels ?? [])];
        if (labels.some((l) => l === top || l.contains(top))) continue;
        issues.push({ check: 'obscured_controls', element: describe(el), detail: `covered by ${describe(top)}` });
      }
      scrollTo(0, y0);
    }
    if (wanted.includes('clipped_text')) {
      for (const el of document.body.querySelectorAll('*')) {
        if (!visible(el) || !(el as HTMLElement).innerText?.trim() || el.children.length > 0) continue;
        const s = getComputedStyle(el);
        const clips = ['hidden', 'clip'].includes(s.overflowX) || ['hidden', 'clip'].includes(s.overflowY);
        if (!clips || s.textOverflow === 'ellipsis') continue;
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) issues.push({ check: 'clipped_text', element: describe(el), detail: `content ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}` });
      }
    }
    return issues;
  }, checks);
}
