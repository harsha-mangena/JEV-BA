import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import { explorationBoundaries, learnRouteUsage, loadCoverageGraph, proposalsFromEquivalenceClasses, transitionCoverage, validateProposal } from '@qa/coverage';
import type { DefectId } from '@qa/fixture-test-app';
import { KeywordProvider, type ChoiceQuestion } from '@qa/s1';
import { runSuite } from '@qa/worker';
import { app, catalog, outDir, policy, ROOT, scenario } from './helpers.ts';

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const graph = await loadCoverageGraph(join(ROOT, 'specs/coverage.yaml'));

async function runProposals(defects: DefectId[]) {
  const scenarios = proposalsFromEquivalenceClasses(graph).map((p) => {
    const v = validateProposal(p, { graph, catalog, policy });
    if (!v.ok) throw new Error(v.errors.join('; '));
    return v.scenario;
  });
  const { app: a, fixtures } = await app(defects);
  try {
    return (await runSuite({ scenarios, policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, concurrency: 2 })).report;
  } finally {
    await a.close();
  }
}

describe.concurrent('equivalence-class proposals', () => {
  it('pass on the clean application (oracles come from declared classes, not the app)', async () => {
    const report = await runProposals([]);
    expect(report.cases.map((c) => [c.scenario_id, c.verdict, c.message])).toEqual(report.cases.map((c) => [c.scenario_id, 'PASS', null]));
  });

  it('negative classes catch the validation bypass; the accepted boundary still passes', async () => {
    const report = await runProposals(['validation_bypass']);
    const v = Object.fromEntries(report.cases.map((c) => [c.scenario_id, c.verdict]));
    expect(v).toEqual({ delivery_address_empty: 'FAIL', delivery_address_whitespace_only: 'FAIL', delivery_address_too_long: 'FAIL', delivery_address_max_length: 'PASS' });
  });
});

describe('learning from evidence', () => {
  it('learns observed route usage and transition coverage from run evidence', async () => {
    const { app: a, fixtures } = await app();
    try {
      const { runDir } = await runSuite({
        scenarios: [await scenario('checkout_existing_customer'), await scenario('notes_crud')],
        policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'],
      });
      const usage = await learnRouteUsage([runDir], graph);
      expect(usage.checkout_existing_customer).toEqual(expect.arrayContaining(['/cart', '/orders/:id']));
      expect(usage.notes_crud).toEqual(['/notes']);
      const t = await transitionCoverage([runDir], graph);
      expect(t.covered).toContainEqual(['/cart', '/orders/:id']);
      expect(t.uncovered).toContainEqual(['/login', '/products']);
      expect(t.declared).toBe(graph.transitions.length);
    } finally {
      await a.close();
    }
  });

  it('reports what an exploration covered, including denied actions', async () => {
    const { app: a, fixtures } = await app(['ambiguous_checkout_labels']);
    try {
      const model = new KeywordProvider((req, q: ChoiceQuestion) => {
        const typeHead = req.questions.find((x) => x.id === 'type_target') as ChoiceQuestion | undefined;
        const filled = typeHead?.options.some((o) => o.label.includes('value "1 Test'));
        if (q.id === 'op') return filled ? ['CLICK'] : ['TYPE'];
        if (q.id === 'click_target') return ['"Continue"'];
        if (q.id === 'type_target') return ['"Delivery address"'];
        return ['fixture.delivery_address'];
      });
      const { runDir } = await runSuite({
        scenarios: [await scenario('checkout_exploration', 'exploration')],
        policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, exploration: { s1: model, model: 'm' },
      });
      const [b] = await explorationBoundaries(runDir, graph);
      expect(b!.routes_visited).toEqual(['/cart']);
      expect(b!.controls_acted).toEqual(['TYPE textbox "Delivery address"']);
      expect(b!.denied.length).toBe(1);
    } finally {
      await a.close();
    }
  });
});
