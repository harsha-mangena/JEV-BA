// Independent audit probes. Assertions describe the required safe behavior.
// Failing tests are findings, not intentionally changed production behavior.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import { launchBrowser, OBSERVATION_EXTRACTOR_VERSION } from '@qa/browser';
import { ProjectConfig, validateScenarioSemantics, type Observation, type ProvisionedFixture } from '@qa/contracts';
import { evaluateGate, HEURISTIC_GATE_V0, type GateInput } from '@qa/gate';
import { withCalibration, digestConfig } from '@qa/calibration';
import { TypeSafeProvider, probeRequest, validateResponse, KeywordProvider, type ChoiceQuestion, type S1Request } from '@qa/s1';
import { loadSuite, selectFullSuite, Orchestrator } from '@qa/orchestrator';
import { lintGeneratedSpec, validateGeneratedSpec } from '@qa/compiler';
import { FixtureClient } from '@qa/oracles';
import { runSuite } from '@qa/worker';
import { QUESTION_SCHEMA_VERSION, CANDIDATE_FILTER_VERSION } from '../../apps/worker/src/exploration.ts';
import { app, outDir, policy, catalog, ROOT, scenario, TOKEN } from '../e2e/helpers.ts';

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });
const evidence = (id: string, data: unknown) => console.log(`AUDIT ${id} ${JSON.stringify(data)}`);

it('F01a: TypeSafe requests conform to the published questions-map contract', () => {
  const req = probeRequest('jev-latest');
  const { body } = TypeSafeProvider.encode(req);
  const b = body as any;
  evidence('F01a', { questions_is_array: Array.isArray(b.questions), first_question_fields: Object.keys(b.questions[0] ?? {}) });
  expect(Array.isArray(b.questions), 'API requires a map keyed by question id').toBe(false);
  expect(b.questions.op).toHaveProperty('instructions');
  expect(b.questions.op).toHaveProperty('criteria');
});

it('F01b: decode the official Noul response field', () => {
  const req: S1Request = { model: 'jev-latest', context: 'A form', questions: [{ id: 'form_present', kind: 'noul', prompt: 'Is a form present?' }] };
  const encoded = TypeSafeProvider.encode(req);
  const raw = TypeSafeProvider.decode(req, { model: 'jev-1.13.0', answers: { form_present: { type: 'noul', noul: 0.95 } } }, encoded.keyMaps);
  const v = validateResponse(req, raw);
  evidence('F01b', { valid_heads: Object.keys(v.answers), invalid: v.invalid });
  expect(v.invalid).toEqual({});
});

it('F08: provider timeout still applies when a caller supplies a cancellation signal', async () => {
  const server = createServer((_req, res) => setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'm', answers: {} })); }, 250));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    const p = new TypeSafeProvider({ endpoint, apiKey: 'local-audit-only', timeoutMs: 20 });
    let rejected = false;
    const started = Date.now();
    try { await p.ask(probeRequest('m'), new AbortController().signal); } catch { rejected = true; }
    evidence('F08', { rejected, elapsed_ms: Date.now() - started, configured_timeout_ms: 20 });
    expect(rejected, 'Request should time out before the 250ms response').toBe(true);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

const gateReq: S1Request = { model: 'pinned', context: '{}', questions: [
  { id: 'op', kind: 'choice', prompt: '', options: [{ key: 'CLICK', label: 'CLICK' }, { key: 'DONE', label: 'DONE' }] },
  { id: 'click_target', kind: 'choice', prompt: '', options: [{ key: 't0', label: 'Place order' }, { key: 'NONE', label: 'None' }] },
] };
const obs: Observation = { observation_id: 'o', document_id: 'd', page_id: 'p', timestamp: new Date().toISOString(), route: '/cart', title: 'Cart', viewport: { width: 100, height: 100 }, milestones_completed: [], recent_outcomes: [], diagnostics: [], messages: [], candidates: [{ node_id: 'n', role: 'button', name: 'Place order', tag: 'button', visible: true, enabled: true, editable: false, in_viewport: true, supported_operations: ['CLICK'] }], coverage: { candidates_total: 1, candidates_included: 1, truncated: false, unsupported_frames: 0, shadow_roots_skipped: 0, extraction_errors: [] } };
function gateInput(): GateInput {
  return { config: HEURISTIC_GATE_V0, identity_verified: true, budget: { actions_remaining: 5, reobservations_remaining: 2, s2_remaining: 1, deadline_passed: false }, environment: 'local', project_policy: policy, scenario_policy: { environments: ['local'], mutations: ['test_owned_order_create'], external_effects: 'sandbox_only', allowed_origin_profile: 'owned_checkout', unknown_actions: 'deny' }, observation: obs, s1: validateResponse(gateReq, { resolved_model: 'pinned', answers: { op: { probabilities: { CLICK: 1, DONE: 0 } }, click_target: { probabilities: { t0: 1, NONE: 0 } } } }), target_keys: { click_target: { t0: 'n' } }, truncated_heads: [], binding: () => ({ intent: 'checkout.submit', risk_class: 'test_owned_mutation' }), freshness: async () => ({ current_document_id: 'd', node: { attached: true, visible: true, enabled: true, editable: false } }), recent_no_effect: 0, decision_config_digest: 'new-config' };
}

it('F04a: mismatched calibration must prevent autonomous ACT', async () => {
  const g = gateInput();
  g.config = { ...HEURISTIC_GATE_V0, heuristic: false, calibration_version: 'cal_old', calibrated: { version_id: 'cal_old', decision_config_digest: 'old-config', threshold: 0.99, score: () => 1, supported: () => true } };
  const d = await evaluateGate(g);
  evidence('F04a', { outcome: d.outcome, reasons: d.reason_codes });
  expect(d.outcome).not.toBe('ACT');
});

it('F04b: calibration that cannot qualify an Act band must remain advisory', async () => {
  const g = gateInput();
  g.config = withCalibration(HEURISTIC_GATE_V0, { id: 'cal_unqualified', threshold: null } as any);
  const d = await evaluateGate(g);
  evidence('F04b', { outcome: d.outcome, reasons: d.reason_codes });
  expect(d.outcome).not.toBe('ACT');
});

it('F05: adding a required browser profile changes the suite identity', async () => {
  const cfg = ProjectConfig.parse({ schema_version: 1, environments: { preview: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true } }, version_check: { kind: 'json', path: '/healthz', field: 'commit_sha' }, suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'] }, fixture_api: { token_env: 'QA_FIXTURE_TOKEN' } });
  const changed = structuredClone(cfg);
  changed.suite.profiles!.push('chromium_mobile_viewport');
  const [a, b] = await Promise.all([loadSuite(cfg, ROOT), loadSuite(changed, ROOT)]);
  const oldSelection = selectFullSuite(a, cfg, 'preview', 'a'.repeat(40));
  const newSelection = selectFullSuite(b, changed, 'preview', 'a'.repeat(40));
  evidence('F05', { old_revision: a.revision, new_revision: b.revision, old_required_cases: oldSelection.cases.length, new_required_cases: newSelection.cases.length });
  expect(newSelection.cases.length).toBeGreaterThan(oldSelection.cases.length);
  expect(a.revision).not.toEqual(b.revision);
});

const checkoutModel = () => new KeywordProvider((req, q: ChoiceQuestion) => {
  const route = JSON.parse(req.context).route as string;
  const th = req.questions.find(x => x.id === 'type_target') as ChoiceQuestion | undefined;
  const filled = th?.options.some(o => o.label.includes('value "1 Test'));
  if (q.id === 'op') return route.startsWith('/orders/') ? ['DONE'] : filled || !th ? ['CLICK'] : ['TYPE'];
  if (q.id === 'click_target') return ['"Place order"'];
  if (q.id === 'type_target') return ['"Delivery address"'];
  return ['fixture.delivery_address'];
});

it('F02a: regression cannot bypass a known mutation binding by omitting its intent', async () => {
  const s = structuredClone(await scenario('checkout_existing_customer'));
  s.policy.mutations = [];
  for (const m of s.milestones) { delete m.action_intent; for (const st of m.steps) delete st.intent; }
  const validation = validateScenarioSemantics(s, catalog, policy);
  const { app: a, fixtures } = await app();
  try {
    const { report } = await runSuite({ scenarios: [s], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login' });
    const c = report.cases[0]!;
    evidence('F02a', { validation_issues: validation, mutations_authorized: s.policy.mutations, verdict: c.verdict, backend_order_assertion: c.assertions.find(a => a.type === 'order_count_delta'), gate: report.gate });
    expect(c.verdict, 'Order creation has no authorized mutation').toBe('BLOCKED');
  } finally { await a.close(); }
});

it('F02b: read-only exploration cannot click an unbound control that creates an order', async () => {
  const s = structuredClone(await scenario('checkout_exploration', 'exploration'));
  s.policy.mutations = [];
  s.policy.unknown_actions = 'read_only_exploration';
  const p = structuredClone(policy);
  p.control_bindings = p.control_bindings.filter(b => b.name !== 'Place order');
  const { app: a, fixtures } = await app();
  try {
    const { report } = await runSuite({ scenarios: [s], policy: p, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', exploration: { s1: checkoutModel(), model: 'offline' } });
    const c = report.cases[0]!;
    evidence('F02b', { mutations_authorized: s.policy.mutations, unknown_actions: s.policy.unknown_actions, verdict: c.verdict, backend_order_assertion: c.assertions.find(a => a.type === 'order_count_delta') });
    expect(c.verdict, 'Unknown click must not acquire mutation permission').not.toBe('PASS');
  } finally { await a.close(); }
});

it('F03: generated-spec validation isolates filesystem writes to its work directory', async () => {
  const outside = join(ROOT, '.qa-work', 'audit', 'outside-generated-workdir.txt');
  const workDir = join(ROOT, '.qa-work', 'audit', 'generated-work');
  await rm(outside, { force: true });
  const source = `import { test, expect } from '@playwright/test';\nimport { writeFileSync } from 'fs';\ntest('harmless filesystem containment probe', () => { writeFileSync(${JSON.stringify(outside)}, 'audit sentinel'); expect(1).toBe(1); });\n`;
  try {
    const lint = lintGeneratedSpec(source);
    const result = await validateGeneratedSpec(source, { workDir, baseUrl: 'http://127.0.0.1:1', fixtureToken: 'audit-fake-token', timeoutMs: 20_000 });
    const written = await readFile(outside, 'utf8').then(v => v === 'audit sentinel', () => false);
    evidence('F03', { lint, validation_status: result.status, wrote_outside_workdir: written });
    expect(written).toBe(false);
  } finally { await rm(outside, { force: true }); await rm(workDir, { recursive: true, force: true }); }
});

it('F06: trace archives do not contain fixture session credentials', async () => {
  const { app: a } = await app();
  class RecordedFixtures extends FixtureClient {
    seen: ProvisionedFixture[] = [];
    override async provision(name: string) { const f = await super.provision(name); this.seen.push(f); return f; }
  }
  const fixtures = new RecordedFixtures(a.url, TOKEN);
  try {
    const { report, runDir } = await runSuite({ scenarios: [await scenario('checkout_existing_customer')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login' });
    expect(report.cases[0]!.verdict).toBe('PASS');
    const trace = report.cases[0]!.artifacts.find(x => x.kind === 'trace');
    expect(trace).toBeDefined();
    const secrets = fixtures.seen.flatMap(f => [...Object.values(f.secrets), ...(f.auth?.cookies.map(c => c.value) ?? [])]);
    // Scan only locally generated disposable fixture credentials; never print their values.
    const scan = spawnSync('python3', ['-c', 'import json,sys,zipfile\nx=json.load(sys.stdin)\nz=zipfile.ZipFile(x["path"])\nhits=[n for n in z.namelist() if any(s.encode() in z.read(n) for s in x["secrets"])]\nprint(json.dumps(hits))'], { input: JSON.stringify({ path: join(runDir, trace!.path), secrets }), encoding: 'utf8' });
    if (scan.status !== 0) throw new Error(scan.stderr);
    const matches = JSON.parse(scan.stdout);
    evidence('F06', { verdict: report.cases[0]!.verdict, archived_files_containing_fixture_credentials: matches });
    expect(matches).toEqual([]);
  } finally { await a.close(); }
});

it('F07: an image-capable S2 receives a screenshot when S1 is ambiguous', async () => {
  const { app: a, fixtures } = await app();
  let s2Input: any;
  const uncertain = new KeywordProvider((_req, q) => q.id === 'op' ? ['CLICK'] : []);
  try {
    await runSuite({ scenarios: [await scenario('checkout_exploration', 'exploration')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', exploration: { s1: uncertain, model: 'offline', s2: { id: 'audit-image-s2', supportsImages: true, async propose(input) { s2Input = input; return { kind: 'ABSTAIN', reason: 'probe complete', evidence_refs: [] }; } } } });
    evidence('F07', { called: !!s2Input, screenshot_present: !!s2Input?.screenshot_png, input_fields: Object.keys(s2Input ?? {}) });
    expect(s2Input).toBeDefined();
    expect(s2Input.screenshot_png).toBeDefined();
  } finally { await a.close(); }
});

it('F05b: promotion gate refuses an old run after the required profile set expands', async () => {
  const cfg = ProjectConfig.parse({ schema_version: 1, environments: { preview: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true } }, version_check: { kind: 'json', path: '/healthz', field: 'commit_sha' }, suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'] }, fixture_api: { token_env: 'QA_FIXTURE_TOKEN' } });
  const old = await loadSuite(cfg, ROOT);
  const changed = structuredClone(cfg);
  changed.suite.profiles!.push('chromium_mobile_viewport');
  // Read-only repository double; production gateStatus and loadSuite are exercised unchanged.
  const db = { async one(sql: string) {
    if (sql.includes('from projects')) return { id: 'shop', tenant_id: 'acme', config: changed };
    if (sql.includes('from deployments')) return { id: 'dep', provider_deployment_id: '42', commit_sha: 'a'.repeat(40) };
    if (sql.includes('from runs')) return { id: 'old-desktop-run', suite_revision: old.revision, state: 'COMPLETED', gate: { eligible: true, reasons: [] } };
    throw new Error(`unhandled query ${sql}`);
  }, async query(sql: string) {
    if (sql.includes('from action_intents')) return { rows: [] }; // no effect obligations for this deployment
    throw new Error(`unhandled query ${sql}`);
  } };
  const orch = new Orchestrator({ db: db as any, suiteBaseDir: ROOT, verifierFor: () => { throw new Error('not used'); }, publisherFor: () => { throw new Error('not used'); } });
  const g = await orch.gateStatus({ tenant_id: 'acme', project_id: 'shop', role: 'viewer', actor: 'audit' }, { project_id: 'shop', environment: 'preview', deployment_id: '42', commit_sha: 'a'.repeat(40) });
  evidence('F05b', g);
  expect(g.eligible).toBe(false);
});

it('F04c: resolved model drift must not receive the old model calibrated Act band', async () => {
  const { app: a, fixtures } = await app();
  const model = 'jev-version-a';
  const inner = checkoutModel();
  const s1 = { id: 'audit-wrong-version', async ask(req: S1Request) { return { ...await inner.ask(req), resolved_model: 'jev-version-b' }; } };
  const configDigest = digestConfig({ model, question_schema_version: QUESTION_SCHEMA_VERSION, extractor_version: OBSERVATION_EXTRACTOR_VERSION, policy_digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16), candidate_filter_version: CANDIDATE_FILTER_VERSION, gate_version: HEURISTIC_GATE_V0.version });
  const gate = { ...HEURISTIC_GATE_V0, heuristic: false, calibration_version: 'cal_model_a', calibrated: { version_id: 'cal_model_a', decision_config_digest: configDigest, threshold: 0.99, score: () => 1, supported: () => true } };
  try {
    const { report, runDir } = await runSuite({ scenarios: [await scenario('checkout_exploration', 'exploration')], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', exploration: { s1, model, gate } });
    const c = report.cases[0]!;
    const file = c.artifacts.find(x => x.kind === 'events')!;
    const events = (await readFile(join(runDir, file.path), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const decisions = events.filter(x => x.kind === 'decision' && x.data?.source === 's1').map(x => ({ requested_model: x.data.requested_model, resolved_model: x.data.resolved_model, reasons: x.data.reason_codes, outcome: x.data.outcome }));
    evidence('F04c', { verdict: c.verdict, decisions });
    expect(c.verdict).not.toBe('PASS');
  } finally { await a.close(); }
});
