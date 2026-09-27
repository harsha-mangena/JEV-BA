import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type Browser } from '@playwright/test';
import type { BrowserName } from './profiles.ts';

/**
 * Launch a pinned browser. `QA_CHROMIUM_EXECUTABLE` / `QA_FIREFOX_EXECUTABLE` /
 * `QA_WEBKIT_EXECUTABLE` override the binary for environments that
 * pre-install a matching build outside Playwright's cache.
 */
export async function launchBrowser(name: BrowserName = 'chromium'): Promise<Browser> {
  const envName = `QA_${name.toUpperCase()}_EXECUTABLE`;
  const executablePath = process.env[envName];
  if (executablePath && !existsSync(executablePath)) throw new Error(`${envName} does not exist: ${executablePath}`);
  const type = { chromium, firefox, webkit }[name];
  return type.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
