import { ensureEvalShim } from '@qa/browser';
import type { Locator, Page } from '@playwright/test';

export async function isFocused(target: Locator): Promise<boolean> {
  if ((await target.count()) !== 1) return false;
  return target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
}

export interface FocusIndicator {
  element: string | null;
  visible: boolean;
  outline: string;
  box_shadow: string;
}

/** Whether the focused element renders a focus indicator (outline or box-shadow ring). */
export async function focusIndicator(page: Page): Promise<FocusIndicator> {
  await ensureEvalShim(page);
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { element: null, visible: false, outline: 'none', box_shadow: 'none' };
    const s = getComputedStyle(el);
    const outlineVisible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const shadowVisible = s.boxShadow !== 'none' && s.boxShadow !== '';
    return {
      element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`,
      visible: outlineVisible || shadowVisible,
      outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
      box_shadow: s.boxShadow,
    };
  });
}
