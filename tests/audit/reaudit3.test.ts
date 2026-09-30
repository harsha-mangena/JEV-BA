// Third-review probes (N1–N3, review of c70d0ef). Assertions describe the
// required safe behaviour; they use only APIs present at the reviewed
// revision, so the same file reproduces each finding there and guards the fix.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchBrowser, safeScreenshot } from '@qa/browser';
import { loadPolicy, type Observation, type ScenarioPolicy } from '@qa/contracts';
import { digestConfig, qualify, QualificationRegistry, type CalibrationVersion } from '@qa/calibration';
import { evaluateGate, HEURISTIC_GATE_V0, type GateConfig, type GateInput } from '@qa/gate';
import { JobWorker, Orchestrator } from '@qa/orchestrator';
import type { FixtureClient } from '@qa/oracles';
import { NONE, validateResponse, type S1Request } from '@qa/s1';
import { runSuite } from '@qa/worker';
import { app, outDir, policy, ROOT, scenario } from '../e2e/helpers.ts';

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });
const evidence = (id: string, data: unknown) => console.log(`REAUDIT3 ${id} ${JSON.stringify(data)}`);

// ---------- N2: in-process retries must not replay an effect-uncertain checkout ----------

async function checkoutWithLostLookup(critical: boolean) {
  const { app: a, fixtures } = await app();
  try {
    // The first lookup that finds the order really happened is answered, then its response is "lost".
    let lost = false;
    let realReceipts = 0;
    const lossy = Object.create(fixtures) as FixtureClient;
    lossy.lookupEffects = async (key, signal) => {
      const r = await fixtures.lookupEffects(key, signal);
      if (!lost && r.receipts.some((x) => x.kind === 'order')) {
        lost = true;
        realReceipts = r.receipts.length;
        throw new Error('effect lookup response lost');
      }
      return r;
    };
    const sc = { ...(await scenario('checkout_existing_customer')), critical };
    const { report } = await runSuite({ scenarios: [sc], policy, baseUrl: a.url, environment: 'local', fixtures: lossy, outDir: await outDir(), browser, profiles: ['chromium_desktop'], retries: 1, signedOutPath: '/login' });
    const checkouts = a.store.writes.filter((w) => w.path === '/checkout').length;
    const c = report.cases[0]!;
    return { real_receipts_before_loss: realReceipts, checkout_dispatches: checkouts, orders: a.store.orders.size, verdict: c.verdict, prior: c.prior_attempts.map((p) => `${p.verdict}/${p.reason}`), gate: report.gate };
  } finally {
    await a.close();
  }
}

it('N2a: a critical required checkout with an unresolved effect is not replayed by a retry, and the gate holds', async () => {
  const r = await checkoutWithLostLookup(true);
  evidence('N2a', r);
  expect(r.real_receipts_before_loss).toBe(1);
  expect(r.checkout_dispatches, 'no second checkout while the first effect is unresolved').toBe(1);
  expect(r.gate.eligible).toBe(false);
});

it('N2b: a noncritical required checkout with an unresolved effect is not replayed, and flaky-pass policy cannot open the gate', async () => {
  const r = await checkoutWithLostLookup(false);
  evidence('N2b', r);
  expect(r.checkout_dispatches, 'no second checkout while the first effect is unresolved').toBe(1);
  expect(r.gate.eligible, 'an unresolved effect obligation must hold the standalone gate').toBe(false);
});

// ---------- N1: rendered secrets outside the text/box the mask covers ----------

const TOKEN = 'tok-5d1e-SECRET-9a0b';
const MAGENTA = (d: Buffer, i: number) => Math.abs(d[i]! - 255) < 8 && d[i + 1]! < 8 && Math.abs(d[i + 2]! - 255) < 8;

function region(png: Buffer, box: { x: number; y: number; width: number; height: number }) {
  const img = PNG.sync.read(png);
  let magenta = 0;
  let dark = 0;
  let n = 0;
  for (let y = Math.max(0, Math.ceil(box.y)); y < Math.min(img.height, Math.floor(box.y + box.height)); y++) {
    for (let x = Math.max(0, Math.ceil(box.x)); x < Math.min(img.width, Math.floor(box.x + box.width)); x++) {
      const i = (y * img.width + x) * 4;
      n++;
      if (MAGENTA(img.data, i)) magenta++;
      else if (img.data[i]! < 110 && img.data[i + 1]! < 110 && img.data[i + 2]! < 110) dark++;
    }
  }
  return { n, magenta, dark };
}

async function page(html: string, fn: (p: Page) => Promise<void>) {
  const p = await browser.newPage({ viewport: { width: 900, height: 400 } });
  try {
    await p.setContent(`<!doctype html><body style="margin:0;font:20px sans-serif;background:#fff;color:#000">${html}</body>`);
    await fn(p);
  } finally {
    await p.close();
  }
}

it('N1 control: an ordinary in-bounds secret is masked and the image is accepted', async () => {
  await page(`<p id="t" style="margin:20px">${TOKEN}</p>`, async (p) => {
    const box = (await p.locator('#t').boundingBox())!;
    const shot = await safeScreenshot(p, { secrets: [TOKEN] });
    expect(shot.ok).toBe(true);
    if (shot.ok) expect(region(shot.png, { x: box.x + 1, y: box.y + 1, width: 200, height: box.height - 2 }).dark).toBe(0);
  });
});

it('N1a: a secret rendered as CSS generated content is masked or the image is withheld', async () => {
  await page(`<style>#g::before{content:attr(data-value)}</style><p id="g" data-value="${TOKEN}" style="margin:20px"></p>`, async (p) => {
    const box = (await p.locator('#g').boundingBox())!;
    const shot = await safeScreenshot(p, { secrets: [TOKEN] });
    const leak = shot.ok ? region(shot.png, { x: 0, y: box.y, width: 900, height: box.height }).dark : 0;
    evidence('N1a', { ok: shot.ok, ...(shot.ok ? { masked: shot.masked, dark_glyph_pixels: leak } : { withheld: shot.withheld }) });
    expect(leak, 'generated-content glyphs must not be visible in an accepted image').toBe(0);
  });
});

it('N1b: a secret overflowing its element box is masked over its full painted extent or the image is withheld', async () => {
  await page(`<div id="o" style="margin:20px;width:40px;white-space:nowrap;overflow:visible">${TOKEN}</div>`, async (p) => {
    const box = (await p.locator('#o').boundingBox())!;
    const shot = await safeScreenshot(p, { secrets: [TOKEN] });
    const outside = shot.ok ? region(shot.png, { x: box.x + box.width + 1, y: box.y, width: 900 - box.x - box.width - 1, height: box.height }).dark : 0;
    evidence('N1b', { ok: shot.ok, ...(shot.ok ? { masked: shot.masked, dark_pixels_outside_mask: outside } : { withheld: shot.withheld }) });
    expect(outside, 'overflowing glyphs must not be visible in an accepted image').toBe(0);
  });
});

// ---------- N3: revocation must reach a shard that already holds a calibrated gate ----------

it('N3: a revoked qualification stops the next calibrated decision of a running shard', async () => {
  const gatePolicy = await loadPolicy(join(ROOT, 'specs/policies/fixture-shop.yaml'));
  const scenarioPolicy: ScenarioPolicy = { environments: ['staging'], mutations: ['test_owned_order_create'], external_effects: 'sandbox_only', allowed_origin_profile: 'owned_checkout', unknown_actions: 'deny' };
  const observation: Observation = {
    observation_id: 'o1', document_id: 'doc1', page_id: 'p', timestamp: new Date().toISOString(), route: '/cart', title: 'Cart', viewport: { width: 1, height: 1 }, milestones_completed: [], recent_outcomes: [], diagnostics: [], messages: [],
    candidates: [{ node_id: 'n1', role: 'button', name: 'Place order', tag: 'button', visible: true, enabled: true, editable: false, in_viewport: true, supported_operations: ['CLICK'] }],
    coverage: { candidates_total: 1, candidates_included: 1, truncated: false, unsupported_frames: 0, shadow_roots_skipped: 0, extraction_errors: [] },
  };
  const req: S1Request = { model: 'm', context: '{}', questions: [
    { id: 'op', kind: 'choice', prompt: '', options: ['CLICK', 'TYPE', 'WAIT', 'DONE', 'BLOCKED'].map((k) => ({ key: k, label: k })) },
    { id: 'click_target', kind: 'choice', prompt: '', options: [{ key: 't0', label: '' }, { key: NONE, label: '' }, { key: 'NEED_MORE_CONTEXT', label: '' }] },
  ] };
  const s1 = validateResponse(req, { answers: { op: { probabilities: { CLICK: 0.98, TYPE: 0, WAIT: 0, DONE: 0.02, BLOCKED: 0 } }, click_target: { probabilities: { t0: 0.99, [NONE]: 0.01, NEED_MORE_CONTEXT: 0 } } } });

  const config = { model: 'jev-1.13.0', question_schema_version: 'q', extractor_version: 'e', policy_digest: 'p', candidate_filter_version: 'c', gate_version: 'g' };
  const band = { threshold: 0.9, accepted: 800, correct: 800, precision: 1, precision_lower: 0.9963, coverage: 0.6, precision_cluster_p05: 0.995 };
  const cal = { id: 'cal1', decision_config: config, decision_config_digest: digestConfig(config), threshold: 0.9, target_precision: 0.99, report: { test_band: band, zero_error_samples_needed: 299 } } as unknown as CalibrationVersion;
  const profile = { project_id: 'shop', environment: 'staging', application: 'fixture-shop/2', resolved_model: 'jev-1.13.0' };
  const record = qualify(profile, { calibration: cal, provider_compat: { ok: true, resolved_model: 'jev-1.13.0', checked_at: new Date(Date.now() - 86_400_000).toISOString() }, dataset: { source: 'representative', applications: ['fixture-shop/2'], labeled_decisions: 4000, double_label_agreement: 0.95 }, episodes: { attempted: 120, verified_success: 115, false_pass: 0 } });
  const registry = new QualificationRegistry(await mkdtemp(join(tmpdir(), 'reaudit3-n3-')));
  await registry.save(record);

  const calibrated: GateConfig = { ...HEURISTIC_GATE_V0, mode: 'calibrated' as never, calibrated: { version_id: 'cal1', decision_config_digest: cal.decision_config_digest, model: 'jev-1.13.0', threshold: 0.9, score: () => 0.97, supported: () => true } };
  const orch = new Orchestrator({ db: {} as never, suiteBaseDir: ROOT, verifierFor: () => { throw new Error('unused'); }, publisherFor: () => { throw new Error('unused'); }, qualifications: registry });
  const worker = new JobWorker(orch, { outDir: tmpdir(), exploration: { s1: { id: 'x', ask: async () => { throw new Error('unused'); } }, model: 'jev-1.13.0', gate: calibrated } as never });
  const held = await (worker as unknown as { qualifiedGate(p: string, e: string, a: string): Promise<GateConfig> }).qualifiedGate('shop', 'staging', 'fixture-shop/2');

  const decide = () => evaluateGate({
    config: held, identity_verified: true, budget: { actions_remaining: 10, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: false }, environment: 'staging', project_policy: gatePolicy, scenario_policy: scenarioPolicy, observation, s1,
    target_keys: { click_target: { t0: 'n1' } }, truncated_heads: [], binding: (op, node) => (op === 'CLICK' && node === 'n1' ? { intent: 'checkout.submit', risk_class: 'test_owned_mutation' } : { risk_class: 'unknown' }),
    freshness: async () => ({ current_document_id: 'doc1', node: { attached: true, visible: true, enabled: true, editable: true } }), recent_no_effect: 0,
    decision_config_digest: cal.decision_config_digest, model: { requested: 'jev-1.13.0', resolved: 'jev-1.13.0' },
  } as GateInput);

  const before = await decide();
  expect(before.outcome, JSON.stringify(before.reason_codes)).toBe('ACT');
  await registry.revoke(record.id, 'admin:ops', 'provider incident');
  expect(await registry.find(profile, cal)).toBeNull();
  const after = await decide();
  evidence('N3', { before: before.outcome, after: after.outcome, after_reasons: after.reason_codes });
  expect(after.outcome, 'a revoked qualification must not authorize the next calibrated action').not.toBe('ACT');
});
