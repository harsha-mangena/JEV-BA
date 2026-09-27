import type { Page } from '@playwright/test';

/**
 * Functions passed to page.evaluate are serialized from source. Under tsx /
 * esbuild with keepNames, nested functions reference a `__name` helper that
 * does not exist in the page. Define a no-op before evaluating.
 */
export async function ensureEvalShim(page: Page): Promise<void> {
  await page.evaluate('globalThis.__name ??= (f) => f');
}
