import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import type { ProvisionedFixture } from '@qa/contracts';
import { FixtureClient } from '@qa/oracles';
import { runSuite, type SuiteOptions } from '@qa/worker';
import { app, outDir, policy, scenario, TOKEN } from './helpers.ts';
import type { DefectId, FixtureApp } from '@qa/fixture-test-app';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/** Fixture client that records provisioned secrets and lets tests inject faults. */
class InstrumentedClient extends FixtureClient {
  provisioned: ProvisionedFixture[] = [];
  mutate?: (f: ProvisionedFixture, n: number) => ProvisionedFixture | Promise<ProvisionedFixture>;
  failCleanup = false;
  override async provision(name: string) {
    let f = await super.provision(name);
    if (this.mutate) f = await this.mutate(f, this.provisioned.length);
    this.provisioned.push(f);
    return f;
  }
  override async cleanup(id: string) {
    if (this.failCleanup) throw new Error('fixture service unavailable');
    return super.cleanup(id);
  }
}

async function withApp<T>(defects: DefectId[], extra: { commitSha?: string; checkoutDelayMs?: number }, fn: (a: FixtureApp, c: InstrumentedClient) => Promise<T>): Promise<T> {
  const { app: a } = await app(defects, extra);
  try {
    return await fn(a, new InstrumentedClient(a.url, TOKEN));
  } finally {
    await a.close();
  }
}

const opts = async (a: FixtureApp, fixtures: FixtureClient, ids: string[], extra: Partial<SuiteOptions> = {}): Promise<SuiteOptions> => ({
  scenarios: await Promise.all(ids.map((id) => scenario(id))),
  policy,
  baseUrl: a.url,
  environment: 'local',
  fixtures,
  outDir: await outDir(),
  browser,
  signedOutPath: '/login',
  profiles: ['chromium_desktop'],
  ...extra,
});

async function allText(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (/\.(jsonl|json|xml|html)$/.test(e.name)) out.push(await readFile(join(d, e.name), 'utf8'));
    }
  };
  await walk(dir);
  return out.join('\n');
}

describe.concurrent('runner safety', () => {
  it('no provisioned secret or session value appears in any report or event log', async () => {
    await withApp([], {}, async (a, c) => {
      const { runDir, report } = await runSuite(await opts(a, c, ['sign_in', 'checkout_existing_customer']));
      expect(report.cases.map((x) => x.verdict)).toEqual(['PASS', 'PASS']);
      const text = await allText(runDir);
      const secrets = c.provisioned.flatMap((f) => [...Object.values(f.secrets), ...(f.auth?.cookies.map((k) => k.value) ?? [])]);
      expect(secrets.length).toBeGreaterThan(2);
      for (const s of secrets) expect(text.includes(s), `secret leaked`).toBe(false);
    });
  });

  it('blocks execution when the target revision does not match the expected SHA', async () => {
    await withApp([], { commitSha: 'b'.repeat(40) }, async (a, c) => {
      const { report } = await runSuite(await opts(a, c, ['checkout_existing_customer'], { commitSha: 'a'.repeat(40) }));
      expect(report.cases[0]).toMatchObject({ verdict: 'BLOCKED', reason: 'version_drift' });
      expect(report.cases[0]!.assertions.every((x) => x.status === 'not_run')).toBe(true);
      expect(c.provisioned).toHaveLength(0);
      expect(report.gate.eligible).toBe(false);
    });
  });

  it('runs when the revision matches', async () => {
    await withApp([], { commitSha: 'c'.repeat(40) }, async (a, c) => {
      const { report } = await runSuite(await opts(a, c, ['viewer_cannot_create_notes'], { commitSha: 'c'.repeat(40) }));
      expect(report.cases[0]!.verdict).toBe('PASS');
      expect(report.gate.eligible).toBe(true);
    });
  });

  it('classifies an expired/invalid session as BLOCKED auth_unavailable, not PASS or FAIL', async () => {
    await withApp([], {}, async (a, c) => {
      c.mutate = (f) => ({ ...f, auth: { cookies: [{ name: 'sid', value: 'expired-session-value' }] } });
      const { report } = await runSuite(await opts(a, c, ['notes_crud']));
      expect(report.cases[0]).toMatchObject({ verdict: 'BLOCKED', reason: 'auth_unavailable' });
      expect(report.cases[0]!.cleanup.status).toBe('done');
    });
  });

  it('refuses to run a scenario in an environment its policy does not permit', async () => {
    await withApp([], {}, async (a, c) => {
      const { report } = await runSuite(await opts(a, c, ['checkout_existing_customer'], { environment: 'production' }));
      expect(report.cases[0]).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
      expect(c.provisioned).toHaveLength(0);
    });
  });

  it('reports a fixture-service failure as ERROR, never PASS', async () => {
    await withApp([], {}, async (a) => {
      const bad = new FixtureClient(a.url, 'wrong-token-wrong-token');
      const { report } = await runSuite(await opts(a, bad, ['checkout_existing_customer']));
      expect(report.cases[0]).toMatchObject({ verdict: 'ERROR', reason: 'fixture_error' });
      expect(report.gate.eligible).toBe(false);
    });
  });

  it('keeps the first failure when a retry passes (FLAKY) and holds a critical journey', async () => {
    await withApp(['total_off_by_one'], {}, async (a, c) => {
      c.mutate = async (f, n) => {
        if (n === 1) await c.setDefects([]);
        return f;
      };
      const { report } = await runSuite(await opts(a, c, ['checkout_existing_customer'], { retries: 1 }));
      const r = report.cases[0]!;
      expect(r.verdict).toBe('FLAKY');
      expect(r.prior_attempts).toHaveLength(1);
      expect(r.prior_attempts[0]).toMatchObject({ verdict: 'FAIL', reason: 'assertion_failed' });
      expect(report.gate.eligible).toBe(false);
      expect(c.provisioned).toHaveLength(2);
      expect(c.provisioned[0]!.fixture_id).not.toBe(c.provisioned[1]!.fixture_id);
    });
  });

  it('waits for a slow checkout without repeating the submission', async () => {
    await withApp([], { checkoutDelayMs: 1500 }, async (a, c) => {
      const { report } = await runSuite(await opts(a, c, ['checkout_existing_customer']));
      expect(report.cases[0]!.verdict, report.cases[0]!.message ?? '').toBe('PASS');
    });
  });

  it('surfaces a cleanup failure and holds the gate even when assertions passed', async () => {
    await withApp([], {}, async (a, c) => {
      c.failCleanup = true;
      const { report } = await runSuite(await opts(a, c, ['viewer_cannot_create_notes']));
      expect(report.cases[0]!.verdict).toBe('PASS');
      expect(report.cases[0]!.cleanup.status).toBe('failed');
      expect(report.gate.eligible).toBe(false);
      expect(report.gate.reasons.join()).toMatch(/cleanup failed/);
    });
  });

  it('does not run exploration scenarios in the deterministic runner', async () => {
    await withApp([], {}, async (a, c) => {
      const s = await scenario('checkout_exploration', 'exploration');
      const { report } = await runSuite({ ...(await opts(a, c, [])), scenarios: [s] });
      expect(report.cases[0]).toMatchObject({ verdict: 'BLOCKED', reason: 'unsupported_capability' });
    });
  });
});
