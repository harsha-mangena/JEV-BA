import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import type { DefectId } from '@qa/fixture-test-app';
import { runSuite } from '@qa/worker';
import { app, outDir, ROOT, scenario } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const ALL = ['checkout_existing_customer', 'checkout_rejects_empty_address', 'notes_crud', 'settings_preference_persists', 'viewer_cannot_create_notes', 'sign_in'];

async function run(ids: string[], defects: DefectId[] = [], extra: Parameters<typeof runSuite>[0] extends infer O ? Partial<O> : never = {}) {
  const { app: a, fixtures } = await app(defects);
  try {
    const scenarios = await Promise.all(ids.map((id) => scenario(id)));
    const { report, runDir } = await runSuite({
      scenarios,
      policy: (await import('./helpers.ts')).policy,
      baseUrl: a.url,
      environment: 'local',
      fixtures,
      outDir: await outDir(),
      browser,
      signedOutPath: '/login',
      concurrency: 3,
      ...extra,
    });
    return { report, runDir, app: a };
  } finally {
    await a.close();
  }
}

describe('clean fixture application', () => {
  it('every approved journey passes on every declared profile and the gate is eligible', async () => {
    const { report, runDir, app: a } = await run(ALL);
    const summary = report.cases.map((c) => `${c.scenario_id}@${c.execution_profile}: ${c.verdict} ${c.message ?? ''}`);
    expect(report.cases.every((c) => c.verdict === 'PASS'), summary.join('\n')).toBe(true);
    expect(report.cases).toHaveLength(8);
    expect(report.gate).toEqual({ eligible: true, reasons: [] });
    // Test-owned entities were cleaned up.
    expect(report.cases.every((c) => c.cleanup.status === 'done')).toBe(true);
    expect(a.store.users.size).toBe(0);
    expect(a.store.orders.size).toBe(0);
    // Reports exist and a trace was captured for a secret-free scenario.
    for (const f of ['report.json', 'junit.xml', 'report.html']) expect((await readFile(join(runDir, f), 'utf8')).length).toBeGreaterThan(100);
    const checkout = report.cases.find((c) => c.scenario_id === 'checkout_existing_customer')!;
    expect(checkout.artifacts.some((x) => x.kind === 'trace')).toBe(true);
    expect(checkout.artifacts.filter((x) => x.kind === 'screenshot').length).toBe(2);
  });
});

/** Each seeded defect must be caught by the scenario that owns the violated requirement. */
const DETECTION: Array<[DefectId, string, string]> = [
  ['checkout_double_submit', 'checkout_existing_customer', 'assertion_failed'],
  ['total_off_by_one', 'checkout_existing_customer', 'assertion_failed'],
  ['validation_bypass', 'checkout_rejects_empty_address', 'assertion_failed'],
  ['confirmation_missing', 'checkout_existing_customer', 'assertion_failed'],
  ['note_delete_ignored', 'notes_crud', 'assertion_failed'],
  ['role_escalation', 'viewer_cannot_create_notes', 'assertion_failed'],
  ['preference_not_persisted', 'settings_preference_persists', 'assertion_failed'],
  ['ambiguous_checkout_labels', 'checkout_existing_customer', 'step_target_unavailable'],
  ['cart_console_error', 'checkout_existing_customer', 'assertion_failed'],
  ['checkout_button_disabled', 'checkout_existing_customer', 'step_target_unavailable'],
  ['checkout_button_renamed', 'checkout_existing_customer', 'step_target_unavailable'],
];

describe('seeded defects', () => {
  it.concurrent.each(DETECTION)('%s fails %s (%s) and holds the gate', async (defect, id, reason) => {
    const { report } = await run([id], [defect], { profiles: ['chromium_desktop'] });
    expect(report.cases).toHaveLength(1);
    const c = report.cases[0]!;
    expect(c.verdict, c.message ?? '').toBe('FAIL');
    expect(c.reason).toBe(reason);
    expect(report.gate.eligible).toBe(false);
    expect(c.cleanup.status).toBe('done');
  });

  it('the defect catalog is fully covered by the detection matrices', async () => {
    const { DEFECTS } = await import('@qa/fixture-test-app');
    const { QUALITY_DETECTION } = await import('./quality.test.ts');
    expect(new Set([...DETECTION.map(([d]) => d), ...QUALITY_DETECTION.map(([d]) => d)])).toEqual(new Set(Object.keys(DEFECTS)));
    expect(ROOT).toBeTruthy();
  });
});
