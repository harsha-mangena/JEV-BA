import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import { parseWith, Scenario, validateScenarioSemantics } from '@qa/contracts';
import { runSuite } from '@qa/worker';
import { app, catalog, outDir, policy, scenario } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

async function run(s: Scenario[], environment: string, readOnly = false) {
  const { app: a, fixtures } = await app();
  try {
    return { ...(await runSuite({ scenarios: s, policy, baseUrl: a.url, environment, fixtures, outDir: await outDir(), browser, readOnly })), app: a };
  } finally {
    await a.close();
  }
}

describe('capability profiles', () => {
  it('a browser that is not installed is BLOCKED, never skipped or passed', async () => {
    const s = { ...(await scenario('sign_in')), execution_profiles: ['firefox_desktop', 'webkit_desktop'] as const };
    const prev = { f: process.env.QA_FIREFOX_EXECUTABLE, w: process.env.QA_WEBKIT_EXECUTABLE };
    process.env.QA_FIREFOX_EXECUTABLE = '/nonexistent/firefox';
    process.env.QA_WEBKIT_EXECUTABLE = '/nonexistent/webkit';
    try {
      const { report } = await run([{ ...s, execution_profiles: [...s.execution_profiles] }], 'local');
      expect(report.cases.map((c) => [c.execution_profile, c.verdict, c.reason])).toEqual([
        ['firefox_desktop', 'BLOCKED', 'unsupported_capability'],
        ['webkit_desktop', 'BLOCKED', 'unsupported_capability'],
      ]);
      expect(report.gate.eligible).toBe(false);
    } finally {
      if (prev.f === undefined) delete process.env.QA_FIREFOX_EXECUTABLE;
      else process.env.QA_FIREFOX_EXECUTABLE = prev.f;
      if (prev.w === undefined) delete process.env.QA_WEBKIT_EXECUTABLE;
      else process.env.QA_WEBKIT_EXECUTABLE = prev.w;
    }
  });

  it('read-only production smoke passes without provisioning anything', async () => {
    const { report, app: a } = await run([await scenario('production_smoke')], 'production', true);
    expect(report.cases[0]!.verdict, report.cases[0]!.message ?? '').toBe('PASS');
    expect(report.cases[0]!.cleanup.status).toBe('skipped');
    expect(a.store.users.size).toBe(0);
  });

  it('read-only profile refuses fixtures, mutations and unbound controls', async () => {
    const withFixture = await run([await scenario('checkout_existing_customer')], 'staging', true);
    expect(withFixture.report.cases.every((c) => c.verdict === 'BLOCKED' && c.reason === 'policy_denied')).toBe(true);
    const clicky = parseWith(
      Scenario,
      {
        schema_version: 1, id: 'prod_click', requirement_ids: ['AUTH-01'], mode: 'regression', start_path: '/login', role: 'anonymous', goal: 'x',
        milestones: [{ id: 'm', steps: [{ op: 'click', target: { role: 'button', name: 'Sign in' } }], assertions: [{ type: 'url_path', equals: '/login' }] }],
        execution_profiles: ['chromium_desktop'], policy: { environments: ['production'], external_effects: 'none', allowed_origin_profile: 'owned_app' }, cleanup: 'none',
      },
      't',
    );
    expect(validateScenarioSemantics(clicky, catalog, policy)).toEqual([]);
    const r = await run([clicky], 'production', true);
    expect(r.report.cases[0]).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(r.report.cases[0]!.message).toMatch(/read-only profile/);
  });

  it('fixture-less scenarios cannot use backend oracles or mutations', () => {
    const s = parseWith(
      Scenario,
      {
        schema_version: 1, id: 'bad', requirement_ids: ['AUTH-01'], mode: 'regression', start_path: '/login', role: 'customer', goal: 'x',
        milestones: [{ id: 'm', assertions: [{ type: 'order_count_delta', customer_ref: 'fixture.customer_id', equals: 0 }] }],
        execution_profiles: ['chromium_desktop'], policy: { environments: ['production'], mutations: ['test_owned_order_create'], external_effects: 'none', allowed_origin_profile: 'owned_app' }, cleanup: 'delete_test_owned_entities',
      },
      't',
    );
    const msgs = validateScenarioSemantics(s, catalog, policy).map((i) => i.message).join('\n');
    expect(msgs).toMatch(/must use role anonymous/);
    expect(msgs).toMatch(/nothing to clean up/);
    expect(msgs).toMatch(/cannot mutate/);
    expect(msgs).toMatch(/needs a fixture-backed backend oracle/);
    expect(msgs).toMatch(/cannot resolve: scenario has no fixture/);
  });
});
