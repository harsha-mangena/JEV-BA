import { existsSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';

/**
 * Launch the pinned Chromium. `QA_CHROMIUM_EXECUTABLE` overrides the binary
 * for environments that pre-install a matching browser outside Playwright's
 * cache.
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.QA_CHROMIUM_EXECUTABLE;
  if (executablePath && !existsSync(executablePath)) throw new Error(`QA_CHROMIUM_EXECUTABLE does not exist: ${executablePath}`);
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
