import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import { FixtureClient } from '@qa/oracles';
import { runSuite } from '@qa/worker';
import { app, outDir, policy, scenario, TOKEN } from './helpers.ts';

/**
 * Review-3 N2: retries inside one execution never replay a case whose earlier
 * effect is unresolved, and an unresolved effect holds the standalone gate
 * whatever the critical/flaky policy. Real browser, real fixture application,
 * real effect lookups; the fault is a lookup that cannot complete.
 */

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/** Counts fixture provisioning (each attempt of a fixture-backed case provisions a fresh fixture). */
function counting(fixtures: FixtureClient) {
  const c = Object.create(fixtures) as FixtureClient & { provisions: number };
  c.provisions = 0;
  c.provision = async (...a: Parameters<FixtureClient['provision']>) => {
    c.provisions++;
    return fixtures.provision(...a);
  };
  return c;
}

describe('retries and effect obligations (review-3 N2)', () => {
  it('a lookup that times out after a real checkout holds the case: no new fixture, no second dispatch, gate held (noncritical, retries 2)', async () => {
    const { app: a } = await app();
    try {
      a.control.effectsDelayMs = 1_500;
      const fixtures = counting(new FixtureClient(a.url, TOKEN, 400)); // every effect lookup times out
      const sc = { ...(await scenario('checkout_existing_customer')), critical: false };
      const { report } = await runSuite({ scenarios: [sc], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], retries: 2, signedOutPath: '/login' });
      const c = report.cases[0]!;
      expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(1);
      expect(fixtures.provisions).toBe(1);
      expect(c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'effect_unreconciled' });
      expect(c.message).toMatch(/not retried: 1 earlier effect\(s\) unresolved/);
      expect(report.gate.eligible).toBe(false);
      expect(report.gate.reasons.join('\n')).toMatch(/effect obligation .* \(checkout\.submit in checkout_existing_customer@chromium_desktop\) is NEEDS_REVIEW/);
      // First-attempt evidence is kept: the attempt's own artifacts are reported.
      expect(c.artifacts.some((x) => x.kind === 'events')).toBe(true);
    } finally {
      await a.close();
    }
  });

  it('cancellation while a checkout is in flight leaves an obligation that holds the gate and is never replayed', async () => {
    const { app: a, fixtures } = await app([], { checkoutDelayMs: 2_000 });
    try {
      const ac = new AbortController();
      const timer = setInterval(() => {
        if (a.store.writes.some((w) => w.path === '/checkout')) {
          clearInterval(timer);
          ac.abort();
        }
      }, 20);
      const { report } = await runSuite({ scenarios: [await scenario('checkout_existing_customer')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], retries: 2, signedOutPath: '/login', signal: ac.signal });
      clearInterval(timer);
      expect(a.store.writes.filter((w) => w.path === '/checkout')).toHaveLength(1);
      expect(report.gate.eligible).toBe(false);
      expect(report.gate.reasons.join('\n')).toMatch(/effect obligation .*checkout\.submit/);
    } finally {
      await a.close();
    }
  });

  it('a normal assertion failure still retries by its declared policy (settled effects are not obligations)', async () => {
    const { app: a, fixtures } = await app(['note_delete_ignored']);
    try {
      const { report } = await runSuite({ scenarios: [await scenario('notes_crud')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], retries: 1, signedOutPath: '/login' });
      const c = report.cases[0]!;
      expect(a.store.writes.filter((w) => w.path === '/notes')).toHaveLength(2);
      expect(c.verdict).toBe('FAIL');
      expect(c.prior_attempts).toHaveLength(1);
      expect(report.gate.reasons.join('\n')).not.toMatch(/effect obligation/);
    } finally {
      await a.close();
    }
  });
});
