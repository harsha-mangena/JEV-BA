import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import { applyRepair, compileJourney, emitPlaywrightSpec, lintGeneratedSpec, proposeLocatorRepair, validateGeneratedSpec, validateRepair, type RepairProposal } from '@qa/compiler';
import type { Scenario } from '@qa/contracts';
import type { DefectId } from '@qa/fixture-test-app';
import { KeywordProvider, type ChoiceQuestion } from '@qa/s1';
import { runSuite } from '@qa/worker';
import { app, catalog, outDir, policy, ROOT, scenario, TOKEN } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const model = () =>
  new KeywordProvider((req, q: ChoiceQuestion) => {
    const route = (JSON.parse(req.context) as { route: string }).route;
    const typeHead = req.questions.find((x) => x.id === 'type_target') as ChoiceQuestion | undefined;
    const filled = typeHead?.options.some((o) => o.label.includes('value "1 Test'));
    if (q.id === 'op') return route.startsWith('/orders/') ? ['DONE'] : filled || !typeHead ? ['CLICK'] : ['TYPE'];
    if (q.id === 'click_target') return ['"Place order"'];
    if (q.id === 'type_target') return ['"Delivery address"'];
    return ['fixture.delivery_address'];
  });

async function run(scenarios: Scenario[], defects: DefectId[] = [], exploration = false) {
  const { app: a, fixtures } = await app(defects);
  try {
    return await runSuite({ scenarios, policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, signedOutPath: '/login', ...(exploration ? { exploration: { s1: model(), model: 'offline' } } : {}) });
  } finally {
    await a.close();
  }
}

async function withApp<T>(defects: DefectId[], fn: (url: string) => Promise<T>): Promise<T> {
  const { app: a } = await app(defects);
  try {
    return await fn(a.url);
  } finally {
    await a.close();
  }
}

describe('regression compilation', () => {
  let compiled: Scenario;

  beforeAll(async () => {
    const source = await scenario('checkout_exploration', 'exploration');
    const { report, runDir } = await run([source], [], true);
    expect(report.cases[0]!.verdict).toBe('PASS');
    const r = await compileJourney({ runDir, result: report.cases[0]!, source, catalog, policy });
    if (!r.ok) throw new Error(r.errors.join('; '));
    compiled = r.scenario;
  });

  it('turns the verified journey into stable role/name steps with the source contract unchanged', async () => {
    const source = await scenario('checkout_exploration', 'exploration');
    expect(compiled.mode).toBe('regression');
    expect(compiled.milestones[0]!.steps).toEqual([
      { op: 'type', target: { role: 'textbox', name: 'Delivery address' }, value_ref: 'fixture.delivery_address' },
      { op: 'click', target: { role: 'button', name: 'Place order' }, intent: 'checkout.submit' },
    ]);
    expect(compiled.milestones[0]!.assertions).toEqual(source.milestones[0]!.assertions);
  });

  it('refuses to compile a journey that did not pass', async () => {
    const source = await scenario('checkout_exploration', 'exploration');
    const { report, runDir } = await run([source], ['total_off_by_one'], true);
    const r = await compileJourney({ runDir, result: report.cases[0]!, source, catalog, policy });
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/only fully verified journeys/)] });
  });

  it('the compiled scenario fails the same seeded bugs as its source contract', async () => {
    const source = await scenario('checkout_exploration', 'exploration');
    for (const defect of ['total_off_by_one', 'checkout_double_submit', 'confirmation_missing'] as DefectId[]) {
      const [c, s] = await Promise.all([run([compiled], [defect]), run([source], [defect], true)]);
      expect(c.report.cases[0]!.verdict, defect).toBe('FAIL');
      expect(s.report.cases[0]!.verdict, defect).not.toBe('PASS');
    }
    expect((await run([compiled])).report.cases[0]!.verdict).toBe('PASS');
  });

  it('emits a Playwright spec that passes on the clean app and fails on the seeded bug, in a restricted process', async () => {
    const spec = emitPlaywrightSpec(compiled);
    expect(lintGeneratedSpec(spec)).toEqual([]);
    const work = join(ROOT, '.qa-work');
    const clean = await withApp([], (url) => validateGeneratedSpec(spec, { workDir: join(work, 'clean'), baseUrl: url, fixtureToken: TOKEN }));
    expect(clean, clean.detail).toMatchObject({ status: 'passed' });
    const buggy = await withApp(['total_off_by_one'], (url) => validateGeneratedSpec(spec, { workDir: join(work, 'buggy'), baseUrl: url, fixtureToken: TOKEN }));
    expect(buggy.status).toBe('failed');
  });

  it('refuses generated code that skips, forces or scripts', async () => {
    const spec = emitPlaywrightSpec(compiled);
    for (const bad of [spec.replace('test(', 'test.skip('), spec.replace('.click();', '.click({ force: true });'), `${spec}\npage.evaluate(() => 1);`]) {
      const r = await validateGeneratedSpec(bad, { workDir: join(ROOT, '.qa-work', 'lint'), baseUrl: 'http://127.0.0.1:1', fixtureToken: 'x' });
      expect(r.status).toBe('rejected');
    }
    expect(() => emitPlaywrightSpec({ ...compiled, milestones: [{ ...compiled.milestones[0]!, assertions: [{ type: 'a11y_scan', fail_on: 'serious', disable_rules: [] }] }] })).toThrow(/unsupported assertion/);
  });
});

describe('controlled repairs', () => {
  it('proposes a locator repair for a renamed control; the repaired contract passes and still catches bugs', async () => {
    const original = await scenario('checkout_existing_customer');
    const failing = await run([original], ['checkout_button_renamed']);
    const c = failing.report.cases.find((x) => x.execution_profile === 'chromium_desktop')!;
    expect(c).toMatchObject({ verdict: 'FAIL', reason: 'step_target_unavailable' });
    const p = (await proposeLocatorRepair({ runDir: failing.runDir, result: c, scenario: original })) as RepairProposal;
    expect(p.kind).toBe('locator');
    expect(p.patch).toEqual([{ path: 'milestones.1.steps.1.target', from: { role: 'button', name: 'Place order' }, to: { role: 'button', name: 'Place your order' } }]);
    const repaired = applyRepair(original, p);
    expect(validateRepair(original, repaired)).toEqual({ ok: true, classification: 'locator', violations: [] });
    const rerun = await run([repaired], ['checkout_button_renamed']);
    expect(rerun.report.cases.map((x) => x.verdict)).toEqual(['PASS', 'PASS']);
    const stillCatches = await run([repaired], ['checkout_button_renamed', 'total_off_by_one']);
    expect(stillCatches.report.cases.every((x) => x.verdict === 'FAIL')).toBe(true);
    expect(() => applyRepair(repaired, p)).toThrow(/changed since/);
  });

  it('does not propose repairs for disabled controls or ambiguous replacements', async () => {
    const original = await scenario('checkout_existing_customer');
    for (const defect of ['checkout_button_disabled', 'ambiguous_checkout_labels'] as DefectId[]) {
      const { report, runDir } = await run([original], [defect]);
      const c = report.cases.find((x) => x.execution_profile === 'chromium_desktop')!;
      expect(await proposeLocatorRepair({ runDir, result: c, scenario: original }), defect).toHaveProperty('none');
    }
  });

  it('classifies anything touching what is verified as a semantic requirement change', async () => {
    const s = await scenario('checkout_existing_customer');
    const dropAssertion = structuredClone(s);
    dropAssertion.milestones[1]!.assertions.pop();
    const loosen = structuredClone(s);
    loosen.milestones[1]!.assertions[1] = { type: 'order_count_delta', customer_ref: 'fixture.customer_id', equals: 2 };
    const policyEdit = structuredClone(s);
    policyEdit.policy.mutations = [];
    const shorter = structuredClone(s);
    shorter.budgets.action_timeout_ms = 1000;
    const longer = structuredClone(s);
    longer.budgets.action_timeout_ms = 10_000;
    for (const bad of [dropAssertion, loosen, policyEdit, shorter]) expect(validateRepair(s, bad)).toMatchObject({ ok: false, classification: 'semantic_requirement_change' });
    expect(validateRepair(s, longer)).toEqual({ ok: true, classification: 'wait', violations: [] });
  });
});
