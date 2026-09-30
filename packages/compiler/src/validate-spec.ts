import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { lintGeneratedSpec } from './playwright.ts';
import { runSandboxed, sandboxAvailable } from './sandbox.ts';

export interface SpecValidation {
  status: 'passed' | 'failed' | 'rejected' | 'error';
  detail: string;
  lint: string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Run a generated spec inside the namespace sandbox: its own work directory
 * is the only writable host path, the application under test is the only
 * reachable network endpoint, nothing from the host environment is inherited,
 * a hard timeout kills the process tree, and the whole tree runs under an
 * enforced memory limit. There is no host fallback: if the sandbox or its
 * memory limit cannot be established the result is `error`, never `passed`.
 */
/** Memory the generated test (runner and browser together) may use; overridable with QA_SANDBOX_MEMORY_MB. */
export const GENERATED_SPEC_MEMORY_BYTES = 2048 * 1024 * 1024;

export async function validateGeneratedSpec(source: string, o: { workDir: string; baseUrl: string; fixtureToken: string; timeoutMs?: number; memoryBytes?: number }): Promise<SpecValidation> {
  const lint = lintGeneratedSpec(source);
  if (lint.length) return { status: 'rejected', detail: lint.join('; '), lint };
  const sandbox = await sandboxAvailable();
  if (!sandbox.ok) return { status: 'error', detail: `sandbox unavailable; generated code is never run on the host: ${sandbox.detail}`, lint };

  const target = new URL(o.baseUrl);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  // Inside the sandbox the application is reachable only through the relay on loopback.
  const insideBase = LOOPBACK.has(target.hostname) ? o.baseUrl : `${target.protocol}//127.0.0.1:${port}${target.pathname}`;

  await rm(o.workDir, { recursive: true, force: true });
  await mkdir(o.workDir, { recursive: true });
  await writeFile(join(o.workDir, 'generated.spec.ts'), source);
  await writeFile(
    join(o.workDir, 'playwright.config.mjs'),
    `export default { testDir: '.', outputDir: './test-results', workers: 1, retries: 0, timeout: 60000, reporter: [['json', { outputFile: 'results.json' }]], use: { headless: true } };\n`,
  );
  const require = createRequire(import.meta.url);
  const pwTest = dirname(require.resolve('@playwright/test/package.json'));
  const nodeModules = dirname(dirname(pwTest));
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? '/root', '.cache', 'ms-playwright');
  const r = await runSandboxed({
    command: [process.execPath, '/sandbox/node_modules/@playwright/test/cli.js', 'test', '--config', '/sandbox/work/playwright.config.mjs'],
    workDir: o.workDir,
    nodeModules,
    readOnly: [browsers],
    env: { QA_BASE_URL: insideBase, QA_FIXTURE_TOKEN: o.fixtureToken, PLAYWRIGHT_BROWSERS_PATH: browsers },
    allowTcp: { host: LOOPBACK.has(target.hostname) ? '127.0.0.1' : target.hostname, port },
    timeoutMs: o.timeoutMs ?? 120_000,
    limits: { memoryBytes: o.memoryBytes ?? (Number(process.env.QA_SANDBOX_MEMORY_MB) > 0 ? Number(process.env.QA_SANDBOX_MEMORY_MB) * 1024 * 1024 : GENERATED_SPEC_MEMORY_BYTES) },
  });
  if (r.status === 'unavailable') return { status: 'error', detail: `sandbox could not start: ${r.stderr.slice(0, 300)}`, lint };
  if (r.exceeded === 'memory') return { status: 'error', detail: `exceeded the sandbox memory limit; process tree killed`, lint };
  if (r.status === 'timeout') return { status: 'error', detail: `timed out after ${o.timeoutMs ?? 120_000} ms; process tree killed`, lint };
  try {
    const res = JSON.parse(await readFile(join(o.workDir, 'results.json'), 'utf8')) as { stats: { expected: number; unexpected: number; skipped: number; flaky: number } };
    if (res.stats.skipped > 0 || res.stats.flaky > 0) return { status: 'failed', detail: `skipped=${res.stats.skipped} flaky=${res.stats.flaky}`, lint };
    return res.stats.unexpected === 0 && res.stats.expected > 0 ? { status: 'passed', detail: `${res.stats.expected} test(s) passed`, lint } : { status: 'failed', detail: `${res.stats.unexpected} unexpected failure(s) (exit ${r.code})`, lint };
  } catch {
    return { status: 'error', detail: `no results produced (exit ${r.code}): ${r.stderr.slice(-300)}`, lint };
  }
}
