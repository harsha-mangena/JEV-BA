import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit, type Browser } from '@playwright/test';
import type { BrowserName } from './profiles.ts';

const require = createRequire(import.meta.url);

/** Browser builds pinned by the installed Playwright (what an execution contract binds to). */
export function pinnedBrowserIdentity(): { playwright: string; browsers: Record<BrowserName, string | null> } {
  const pkg = require.resolve('playwright-core/package.json');
  const manifest = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; browserVersion?: string }> };
  const v = (n: string) => manifest.browsers.find((b) => b.name === n)?.browserVersion ?? null;
  return { playwright: (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version, browsers: { chromium: v('chromium'), firefox: v('firefox'), webkit: v('webkit') } };
}

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
