import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, observe, resolveNode } from '@qa/browser';
import { KeywordProvider, type ChoiceQuestion, type S1Request, type SystemOneProvider } from '@qa/s1';
import type { SystemTwoProvider } from '@qa/s2';
import type { DefectId } from '@qa/fixture-test-app';
import { runSuite, type ExplorationOptions } from '@qa/worker';
import { app, outDir, policy, scenario } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/**
 * Offline stand-in "model" for the checkout goal. It reads only what a real
 * S1 would see — the request's questions and untrusted context — and has no
 * access to the DOM or the fixture.
 */
function checkoutModel(clickPreference = '"Place order"'): KeywordProvider {
  return new KeywordProvider((req: S1Request, q: ChoiceQuestion) => {
    const route = (JSON.parse(req.context) as { route: string }).route;
    const typeHead = req.questions.find((x) => x.id === 'type_target') as ChoiceQuestion | undefined;
    const addressFilled = typeHead?.options.some((o) => o.label.includes('Delivery address') && o.label.includes('value "1 Test'));
    switch (q.id) {
      case 'op':
        if (route.startsWith('/orders/')) return ['DONE'];
        return addressFilled || !typeHead ? ['CLICK'] : ['TYPE'];
      case 'click_target':
        return [clickPreference];
      case 'type_target':
        return ['"Delivery address"'];
      case 'type_value':
        return ['fixture.delivery_address'];
      default:
        return [];
    }
  });
}

async function explore(defects: DefectId[], exploration: ExplorationOptions, scenarioPatch: (s: Awaited<ReturnType<typeof scenario>>) => void = () => undefined) {
  const { app: a, fixtures } = await app(defects);
  try {
    const s = await scenario('checkout_exploration', 'exploration');
    scenarioPatch(s);
    const { report } = await runSuite({ scenarios: [s], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, signedOutPath: '/login', exploration });
    return { report, app: a, c: report.cases[0]! };
  } finally {
    await a.close();
  }
}

describe.concurrent('observation', () => {
  it('extracts candidates, separates diagnostics, redacts passwords and detects stale nodes', async () => {
    const { app: a, fixtures } = await app(['checkout_button_disabled']);
    const ctx = await browser.newContext();
    try {
      const f = await fixtures.provision('customer_cart_one_item_v1');
      await ctx.addCookies(f.auth!.cookies.map((c) => ({ ...c, url: a.url })));
      const page = await ctx.newPage();
      await page.goto(`${a.url}/cart`);
      const o = await observe(page, { pageId: 'p' });
      const names = o.candidates.map((c) => `${c.role}:${c.name}`);
      expect(names).toEqual(expect.arrayContaining(['textbox:Delivery address', 'button:Save cart for later', 'link:Cart']));
      expect(names).not.toContain('button:Place order');
      expect(o.diagnostics.find((d) => d.name === 'Place order')).toMatchObject({ enabled: false, supported_operations: [] });
      expect(o.candidates.find((c) => c.name === 'Delivery address')).toMatchObject({ supported_operations: ['TYPE'], section: 'Checkout', form: 'Checkout' });
      expect(o.coverage).toMatchObject({ truncated: false, unsupported_frames: 0, extraction_errors: [] });

      // Node ids are stable within a document and stale after navigation.
      const again = await observe(page, { pageId: 'p' });
      expect(again.document_id).toBe(o.document_id);
      const addr = o.candidates.find((c) => c.name === 'Delivery address')!;
      expect(again.candidates.find((c) => c.name === 'Delivery address')!.node_id).toBe(addr.node_id);
      expect((await resolveNode(page, o.document_id, addr.node_id)).ok).toBe(true);
      await page.goto(`${a.url}/products`);
      expect(await resolveNode(page, o.document_id, addr.node_id)).toEqual({ ok: false, reason: 'stale_document' });

      // Password values never leave the page.
      await page.context().clearCookies();
      await page.goto(`${a.url}/login`);
      await page.getByLabel('Password').fill('hunter2-secret');
      const login = await observe(page, { pageId: 'p' });
      expect(login.candidates.find((c) => c.name === 'Password')!.value).toBe('[REDACTED]');
      expect(JSON.stringify(login)).not.toContain('hunter2');
    } finally {
      await ctx.close();
      await a.close();
    }
  });

  it('bounds candidates and reports truncation', async () => {
    const { app: a } = await app();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.setContent(`<main>${Array.from({ length: 30 }, (_, i) => `<button>Item ${i}</button>`).join('')}<iframe srcdoc="<button>x</button>"></iframe></main>`);
      const o = await observe(page, { pageId: 'p', maxCandidates: 10 });
      expect(o.candidates).toHaveLength(10);
      expect(o.coverage).toMatchObject({ candidates_total: 30, candidates_included: 10, truncated: true, unsupported_frames: 1 });
    } finally {
      await ctx.close();
      await a.close();
    }
  });
});

describe.concurrent('S1-guided exploration', () => {
  it('reaches the checkout milestone and passes only through independent verification', async () => {
    const model = checkoutModel();
    const { c, report } = await explore([], { s1: model, model: 'keyword-offline@test' });
    expect(c.verdict, c.message ?? '').toBe('PASS');
    expect(c.milestones_completed).toEqual(['order_persisted']);
    expect(c.assertions.every((x) => x.status === 'passed')).toBe(true);
    // Exploration is advisory: it never satisfies the release gate on its own.
    expect(report.gate.eligible).toBe(false);
    expect(model.requests.length).toBeGreaterThanOrEqual(3);
  });

  it('a DONE claim cannot hide a product defect', async () => {
    const { c } = await explore(['total_off_by_one'], { s1: checkoutModel(), model: 'm' });
    expect(c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'assertion_failed' });
  });

  it('denies a confident click on a control with unknown semantics', async () => {
    const { c, app: a } = await explore(['ambiguous_checkout_labels'], { s1: checkoutModel('"Continue"'), model: 'm' });
    // Both buttons read "Continue"; neither matches a trusted binding, so permission fails before uncertainty is even considered.
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/unknown_action_semantics/);
    expect(a.store.orders.size).toBe(0);
  });

  it('abstains when S1 cannot tell the checkout controls apart', async () => {
    const { c, app: a } = await explore(['ambiguous_checkout_labels'], { s1: checkoutModel(), model: 'm' });
    expect(c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'autonomy_abstained' });
    expect(c.message).toMatch(/target_uncertain/);
    expect(a.store.orders.size).toBe(0);
  });

  it('never clicks a mutating control the scenario does not authorize, however confident S1 is', async () => {
    const { c, app: a } = await explore([], { s1: checkoutModel(), model: 'm' }, (s) => {
      s.policy.mutations = [];
    });
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(a.store.orders.size).toBe(0);
  });

  it('reports a provider outage as ERROR, not FAIL or PASS', async () => {
    const down: SystemOneProvider = { id: 'down', ask: async () => Promise.reject(new Error('503 Service Unavailable')) };
    const { c } = await explore([], { s1: down, model: 'm', providerRetries: 1 });
    expect(c).toMatchObject({ verdict: 'ERROR', reason: 'provider_unavailable' });
  });

  it('abstains on malformed provider output instead of repairing it', async () => {
    const garbage: SystemOneProvider = { id: 'garbage', ask: async () => ({ answers: { op: { probabilities: { CLICK: Number.NaN } } } }) };
    const { c } = await explore([], { s1: garbage, model: 'm' });
    expect(c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'autonomy_abstained' });
  });

  it('escalates an ambiguous target to S2, whose selection still passes permission and freshness checks', async () => {
    // S1 splits between the two checkout buttons (plan §3.2); S2 picks the observed "Place order" node.
    const base = checkoutModel();
    const split: SystemOneProvider = {
      id: 'split',
      async ask(req) {
        const r = await base.ask(req);
        const click = req.questions.find((q) => q.id === 'click_target') as ChoiceQuestion | undefined;
        if (click) {
          const place = click.options.find((o) => o.label.includes('"Place order"'))?.key;
          const save = click.options.find((o) => o.label.includes('"Save cart for later"'))?.key;
          if (place && save) r.answers.click_target = { probabilities: Object.fromEntries(click.options.map((o) => [o.key, o.key === place ? 0.48 : o.key === save ? 0.44 : 0.08 / (click.options.length - 2)])) };
        }
        return r;
      },
    };
    const calls: string[] = [];
    const s2: SystemTwoProvider = {
      id: 's2-fake',
      supportsImages: false,
      async propose(input) {
        const place = input.observation.candidates.find((c) => c.name === 'Place order')!;
        calls.push(place.node_id);
        return { kind: 'SELECT_OBSERVED_TARGET', node_id: place.node_id, evidence_refs: ['section:Checkout'], reason: 'Primary submit in the checkout form' };
      },
    };
    const { c } = await explore([], { s1: split, s2, model: 'm' });
    expect(c.verdict, c.message ?? '').toBe('PASS');
    expect(calls).toHaveLength(1);

    const rogue: SystemTwoProvider = { id: 'rogue', supportsImages: false, propose: async () => ({ kind: 'SELECT_OBSERVED_TARGET', node_id: 'n1', evidence_refs: [], reason: '', selector: '#place-order' }) };
    const r2 = await explore([], { s1: split, s2: rogue, model: 'm' });
    expect(r2.c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'autonomy_abstained' });
    expect(r2.app.store.orders.size).toBe(0);
  });
});
