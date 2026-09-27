import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lintGeneratedSpec } from './playwright.ts';

export interface SpecValidation {
  status: 'passed' | 'failed' | 'rejected' | 'error';
  detail: string;
  lint: string[];
}

/**
 * Run a generated spec in a restricted child process: a fresh working
 * directory, a minimal environment (no inherited credentials), one worker,
 * no retries and a hard timeout. `workDir` must be inside a directory whose
 * node_modules provides @playwright/test.
 */
export async function validateGeneratedSpec(source: string, o: { workDir: string; baseUrl: string; fixtureToken: string; timeoutMs?: number }): Promise<SpecValidation> {
  const lint = lintGeneratedSpec(source);
  if (lint.length) return { status: 'rejected', detail: lint.join('; '), lint };
  await rm(o.workDir, { recursive: true, force: true });
  await mkdir(o.workDir, { recursive: true });
  await writeFile(join(o.workDir, 'generated.spec.ts'), source);
  const exe = process.env.QA_CHROMIUM_EXECUTABLE;
  await writeFile(
    join(o.workDir, 'playwright.config.mjs'),
    `export default { testDir: '.', workers: 1, retries: 0, timeout: 60000, reporter: [['json', { outputFile: 'results.json' }]], use: { headless: true${exe ? `, launchOptions: { executablePath: ${JSON.stringify(exe)} }` : ''} } };\n`,
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: o.workDir,
    QA_BASE_URL: o.baseUrl,
    QA_FIXTURE_TOKEN: o.fixtureToken,
    // HOME is isolated, so point Playwright at the real browser cache explicitly.
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? defaultBrowsersPath(),
  };
  const cli = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', '--config', join(o.workDir, 'playwright.config.mjs')], { cwd: o.workDir, env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 120_000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  try {
    const r = JSON.parse(await readFile(join(o.workDir, 'results.json'), 'utf8')) as { stats: { expected: number; unexpected: number; skipped: number; flaky: number } };
    if (r.stats.skipped > 0 || r.stats.flaky > 0) return { status: 'failed', detail: `skipped=${r.stats.skipped} flaky=${r.stats.flaky}`, lint };
    return r.stats.unexpected === 0 && r.stats.expected > 0 ? { status: 'passed', detail: `${r.stats.expected} test(s) passed`, lint } : { status: 'failed', detail: `${r.stats.unexpected} unexpected failure(s) (exit ${code})`, lint };
  } catch {
    return { status: 'error', detail: `no results produced (exit ${code})`, lint };
  }
}

function defaultBrowsersPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}
