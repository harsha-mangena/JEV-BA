import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, observe, resolveNode } from '@qa/browser';
import type { CaseResult } from '@qa/contracts';
import { KeywordProvider, type ChoiceQuestion, type S1Request, type SystemOneProvider } from '@qa/s1';
import type { S2EscalationInput, SystemTwoProvider } from '@qa/s2';
import { runSuite, type ExplorationOptions } from '@qa/worker';
import { app, outDir, policy, scenario } from './helpers.ts';

/**
 * Explicit observation and action capabilities (audit F07, F10): open shadow
 * DOM, SELECT and SCROLL executors, System Two context fulfillment with
 * screenshots, subgoals and loop detection.
 */

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

async function explore(id: string, exploration: ExplorationOptions) {
  const { app: a, fixtures } = await app();
  try {
    const { report, runDir } = await runSuite({ scenarios: [await scenario(id, 'exploration')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, signedOutPath: '/login', exploration });
    return { c: report.cases[0]!, runDir, app: a };
  } finally {
    await a.close();
  }
}

async function events(runDir: string, c: CaseResult) {
  return (await readFile(join(runDir, c.artifacts.find((x) => x.kind === 'events')!.path), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; summary: string; data: Record<string, unknown> });
}

/** Offline checkout model whose target head splits between the two checkout buttons (forces escalation). */
function splitCheckout(): KeywordProvider & SystemOneProvider {
  const base = new KeywordProvider((req: S1Request, q: ChoiceQuestion) => {
    const route = (JSON.parse(req.context) as { route: string }).route;
    const th = req.questions.find((x) => x.id === 'type_target') as ChoiceQuestion | undefined;
    const filled = th?.options.some((o) => o.label.includes('Delivery address') && o.label.includes('value "1 Test'));
    if (q.id === 'op') return route.startsWith('/orders/') ? ['DONE'] : filled || !th ? ['CLICK'] : ['TYPE'];
    if (q.id === 'type_target') return ['"Delivery address"'];
    if (q.id === 'type_value') return ['fixture.delivery_address'];
    return [];
  });
  const ask = base.ask.bind(base);
  base.ask = async (req) => {
    const r = await ask(req);
    const click = req.questions.find((q) => q.id === 'click_target') as ChoiceQuestion | undefined;
    if (click) {
      const place = click.options.find((o) => o.label.includes('"Place order"'))?.key;
      const save = click.options.find((o) => o.label.includes('"Save cart for later"'))?.key;
      if (place && save) r.answers.click_target = { probabilities: Object.fromEntries(click.options.map((o) => [o.key, o.key === place ? 0.48 : o.key === save ? 0.44 : 0.08 / (click.options.length - 2)])) };
    }
    return r;
  };
  return base;
}

function scriptedS2(script: Array<(input: S2EscalationInput) => unknown>, supportsImages = false): SystemTwoProvider & { inputs: S2EscalationInput[] } {
  const inputs: S2EscalationInput[] = [];
  return {
    id: 's2-scripted',
    supportsImages,
    inputs,
    async propose(input) {
      inputs.push(input);
      return script[Math.min(inputs.length - 1, script.length - 1)]!(input);
    },
  };
}
const selectPlace = (input: S2EscalationInput) => ({ kind: 'SELECT_OBSERVED_TARGET', node_id: input.observation.candidates.find((c) => c.name === 'Place order')!.node_id, evidence_refs: ['section:Checkout'], reason: 'primary submit' });

describe('observation capabilities', () => {
  it('extracts and acts on controls inside open shadow roots', async () => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.setContent(`<main><p id="out">idle</p><x-widget></x-widget></main>
        <script>customElements.define('x-widget', class extends HTMLElement { connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<button>Shadow action</button>';
          root.querySelector('button').onclick = () => { document.getElementById('out').textContent = 'clicked'; };
        } });</script>`);
      const o = await observe(page, { pageId: 'p' });
      const btn = o.candidates.find((c) => c.name === 'Shadow action');
      expect(btn).toMatchObject({ role: 'button', supported_operations: ['CLICK'] });
      expect(o.coverage).toMatchObject({ shadow_roots_traversed: 1, shadow_roots_skipped: 0 });
      const r = await resolveNode(page, o.document_id, btn!.node_id);
      expect(r.ok).toBe(true);
      if (r.ok) await r.handle.click();
      expect(await page.textContent('#out')).toBe('clicked');
    } finally {
      await ctx.close();
    }
  });
});

describe.concurrent('exploration capabilities', () => {
  it('chooses a page-offered option with SELECT and passes only through the approved assertions', async () => {
    const s1 = new KeywordProvider((req, q) => {
      const ctx = JSON.parse(req.context) as { messages?: Array<{ text: string }> };
      const sel = req.questions.find((x) => x.id === 'select_target') as ChoiceQuestion | undefined;
      const dark = sel?.options.some((o) => o.label.includes('"Theme"') && o.label.includes('value "Dark"'));
      if (q.id === 'op') return ctx.messages?.some((m) => m.text.includes('Settings saved')) ? ['DONE'] : dark ? ['CLICK'] : ['SELECT'];
      if (q.id === 'select_target') return ['"Theme"'];
      if (q.id === 'select_value') return ['Dark'];
      if (q.id === 'click_target') return ['"Save settings"'];
      return [];
    });
    const { c, runDir } = await explore('settings_exploration', { s1, model: 'm' });
    expect(c.verdict, c.message ?? '').toBe('PASS');
    const ev = await events(runDir, c);
    expect(ev.some((e) => e.summary.startsWith('select option o'))).toBe(true);
    expect(ev.some((e) => e.kind === 'intent_transition' && e.data.state === 'ACKNOWLEDGED')).toBe(true);
  });

  it('fulfils an S2 request for more context, then acts on its selection', async () => {
    const s2 = scriptedS2([() => ({ kind: 'REQUEST_CONTEXT', need: 'wait_for_load', evidence_refs: [], reason: 'page may still be loading' }), selectPlace]);
    const { c, runDir } = await explore('checkout_exploration', { s1: splitCheckout(), s2, model: 'm' });
    expect(c.verdict, c.message ?? '').toBe('PASS');
    expect(s2.inputs).toHaveLength(2);
    expect((await events(runDir, c)).some((e) => e.summary === 's2 context fulfilled: wait_for_load')).toBe(true);
  });

  it('sends a masked screenshot to an image-capable S2 and steers S1 with a bounded subgoal', async () => {
    const s1 = splitCheckout();
    const s2 = scriptedS2([() => ({ kind: 'PROPOSE_SUBGOAL', subgoal: 'Submit the checkout form', evidence_refs: ['screenshot'], reason: 'the primary button submits' }), selectPlace], true);
    const { c } = await explore('checkout_exploration', { s1, s2, model: 'm' });
    expect(c.verdict, c.message ?? '').toBe('PASS');
    expect(s2.inputs[0]!.screenshot_png!.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    const later = s1.requests.map((r) => r.questions.find((q) => q.id === 'op')!.prompt).filter((p) => p.includes('Submit the checkout form'));
    expect(later.length).toBeGreaterThan(0);
  });

  it('refuses an S2 request for context it already has, and bounds S2 calls', async () => {
    const again = scriptedS2([() => ({ kind: 'REQUEST_CONTEXT', need: 'screenshot', evidence_refs: [], reason: 'need to see it' })], true);
    const r1 = await explore('checkout_exploration', { s1: splitCheckout(), s2: again, model: 'm' });
    expect(r1.c).toMatchObject({ verdict: 'NEEDS_REVIEW', reason: 'autonomy_abstained' });
    expect(r1.c.message).toMatch(/already has/);
    const stalling = scriptedS2([() => ({ kind: 'REQUEST_CONTEXT', need: 'wait_for_load', evidence_refs: [], reason: 'wait' })]);
    const r2 = await explore('checkout_exploration', { s1: splitCheckout(), s2: stalling, model: 'm' });
    expect(r2.c.verdict).toBe('NEEDS_REVIEW');
    expect(stalling.inputs.length).toBeLessThanOrEqual(3);
    expect(r2.app.store.orders.size).toBe(0);
  });

  it('detects a loop (a toggle flipping back and forth) and stops', async () => {
    const s1 = new KeywordProvider((_req, q) => (q.id === 'op' ? ['CLICK'] : q.id === 'click_target' ? ['"Send me offers"'] : []));
    const { c, app: a } = await explore('settings_exploration', { s1, model: 'm' });
    expect(c.verdict, c.message ?? '').toBe('NEEDS_REVIEW');
    expect(c.message).toMatch(/loop detected/);
    expect(a.store.writes).toEqual([]);
  });
});
