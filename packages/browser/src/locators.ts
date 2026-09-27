import type { Locator as PwLocator, Page } from '@playwright/test';
import type { Locator } from '@qa/contracts';

type AriaRole = Parameters<Page['getByRole']>[0];

/** Resolve a contract locator using only stable, user-facing selectors. */
export function resolveLocator(page: Page, l: Locator): PwLocator {
  if ('testid' in l) return page.getByTestId(l.testid);
  if ('role' in l) return page.getByRole(l.role as AriaRole, { name: l.name, exact: l.exact ?? true });
  return page.getByLabel(l.label, { exact: true });
}
