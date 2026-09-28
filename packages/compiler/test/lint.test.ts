import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario } from '@qa/contracts';
import { emitPlaywrightSpec, lintGeneratedSpec } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '../../..');
const head = `import { expect, test } from '@playwright/test';\n`;

describe('generated-spec lint', () => {
  it('accepts the emitter output for every emittable approved scenario', async () => {
    const catalog = await loadFixtureCatalog(join(ROOT, 'specs/fixtures.yaml'));
    const policy = await loadPolicy(join(ROOT, 'specs/policies/fixture-shop.yaml'));
    let emitted = 0;
    for (const id of ['checkout_existing_customer', 'notes_crud', 'checkout_rejects_empty_address']) {
      const s = await loadValidatedScenario(join(ROOT, 'specs/scenarios', `${id}.yaml`), catalog, policy);
      let spec: string;
      try {
        spec = emitPlaywrightSpec(s);
      } catch {
        continue; // scenarios with assertions the emitter refuses are covered elsewhere
      }
      expect(lintGeneratedSpec(spec), id).toEqual([]);
      emitted++;
    }
    expect(emitted).toBeGreaterThan(0);
  });

  it.each([
    ['plain fs import (audit F03)', `import { writeFileSync } from 'fs';\n${head}`],
    ['node: fs import', `import * as fs from 'node:fs';\n${head}`],
    ['default import', `import pw from '@playwright/test';`],
    ['unlisted playwright export', `import { chromium } from '@playwright/test';`],
    ['aliased forbidden import', `import { request as expect2 } from '@playwright/test';`],
    ['require', `${head}test('x', () => { require('fs'); });`],
    ['dynamic import', `${head}test('x', async () => { await import('fs'); });`],
    ['computed global', `${head}test('x', () => { (globalThis as any)['proc' + 'ess'].exit(1); });`],
    ['process.exit', `${head}test('x', () => { process.exit(0); });`],
    ['other env var', `${head}test('x', () => { expect(process.env.HOME).toBeTruthy(); });`],
    ['process alias', `${head}const p = process; test('x', () => { p.exit(0); });`],
    ['indirect eval', `${head}test('x', () => { (0, eval)('1'); });`],
    ['Function constructor', `${head}test('x', () => { new Function('return 1')(); });`],
    ['constructor escape', `${head}test('x', () => { (() => 1).constructor('return 1')(); });`],
    ['page.evaluate', `${head}test('x', async ({ page }) => { await page.evaluate(() => 1); });`],
    ['network interception', `${head}test('x', async ({ page }) => { await page.route('**', (r) => r.abort()); });`],
    ['skip', `${head}test.skip('x', () => {});`],
    ['soft assertion', `${head}test('x', () => { expect.soft(1).toBe(1); });`],
    ['forced click', `${head}test('x', async ({ page }) => { await page.getByRole('button').click({ force: true }); });`],
    ['tagged template', `${head}const t = String.raw; test('x', () => { t\`a\`; });`],
    ['import.meta', `${head}test('x', () => { expect(import.meta.url).toBeTruthy(); });`],
  ])('rejects %s', (_name, src) => {
    expect(lintGeneratedSpec(src).length).toBeGreaterThan(0);
  });

  it('allows only the two sanctioned environment variables', () => {
    expect(lintGeneratedSpec(`${head}const B = process.env.QA_BASE_URL!; const T = process.env.QA_FIXTURE_TOKEN!;\ntest('x', () => { expect(B + T).toBeTruthy(); });`)).toEqual([]);
  });
});
