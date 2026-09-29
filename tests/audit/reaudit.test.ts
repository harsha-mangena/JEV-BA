// Re-audit probes (R1–R5, review of merged PR #2 at c750de1). Assertions
// describe the required safe behaviour. They use only APIs that existed at
// the reviewed revision (feature-detecting the newer identity API), so the
// same file reproduces each finding there and guards the fix here.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from '@playwright/test';
import { launchBrowser } from '@qa/browser';
import { ProjectConfig } from '@qa/contracts';
import { qualify, QualificationRegistry, digestConfig, type CalibrationVersion } from '@qa/calibration';
import { readZip, sanitizeTraceArchive, writeZip } from '@qa/evidence';
import * as orchestrator from '@qa/orchestrator';
import type { ApplicationAdapter, EffectLookup } from '@qa/oracles';
import { MemoryIntentStore, recoverIntents } from '@qa/worker';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ROOT } from '../e2e/helpers.ts';

let browser: Browser;
beforeAll(async () => { browser = await launchBrowser(); });
afterAll(async () => { await browser?.close(); });
const evidence = (id: string, data: unknown) => console.log(`REAUDIT ${id} ${JSON.stringify(data)}`);

function adapter(lookups: EffectLookup[]): ApplicationAdapter & { calls: number } {
  const a = {
    id: 'probe', adapter_version: 'probe/1', calls: 0,
    capabilities: { readiness: true, fixtures: true, sessions: true, ownership: true, oracles: [], effect_lookup: true, idempotency: true, cleanup: true, keyed_intents: ['checkout.submit'], idempotency_header: 'x-key' },
    provision: async () => Promise.reject(new Error('unused')), cleanup: async () => 0, entities: async () => [], version: async () => ({ commit_sha: 'x' }),
    async lookupEffects() { return lookups[Math.min(a.calls++, lookups.length - 1)]!; },
  };
  return a;
}
const intent = (over: Record<string, unknown> = {}) => ({ intent_id: 'a1.i1', attempt_id: 'a1', scenario_id: 'checkout', execution_profile: 'chromium_desktop', owner: 'u_1', idempotency_key: 'a1.i1', effect: 'mutation', mutation: 'test_owned_order_create', contract_intent: 'checkout.submit', data: {}, ...over }) as never;

it('R1a: a mutation acknowledged but never confirmed before a crash is reconciled against the application on recovery', async () => {
  const s = new MemoryIntentStore();
  await s.prepare(intent());
  await s.transition('a1.i1', 'DISPATCHING');
  await s.transition('a1.i1', 'ACKNOWLEDGED');
  const a = adapter([{ receipts: [{ kind: 'order', entity_id: 'ord_1', owner: 'u_1', idempotency_key: 'a1.i1', created_at: null }], in_flight: 0 }]);
  await recoverIntents(s, a);
  const state = (await s.get('a1.i1'))!.state;
  evidence('R1a', { lookups: a.calls, state_after_recovery: state });
  expect(a.calls, 'recovery must look the acknowledged mutation up').toBeGreaterThan(0);
  expect(state).not.toBe('ACKNOWLEDGED');
});

it('R1b: a review obligation stays visible to later recovery passes', async () => {
  const s = new MemoryIntentStore();
  await s.prepare(intent({ idempotency_key: null, contract_intent: 'notes.delete' }));
  await s.transition('a1.i1', 'DISPATCHING');
  const first = await recoverIntents(s, adapter([]));
  const second = await recoverIntents(s, adapter([]));
  evidence('R1b', { first: first.map((r) => r.state), second: second.map((r) => r.state) });
  expect(first.map((r) => r.state)).toEqual(['NEEDS_REVIEW']);
  expect(second.map((r) => [r.intent_id, r.state]), 'the second pass must still surface the unresolved review').toEqual([['a1.i1', 'NEEDS_REVIEW']]);
});

const cfg = (fixtureUrl?: string) =>
  ProjectConfig.parse({
    schema_version: 1,
    environments: { staging: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true } },
    version_check: { kind: 'json', path: '/healthz', field: 'commit_sha' },
    suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'] },
    fixture_api: { token_env: 'QA_FIXTURE_TOKEN', ...(fixtureUrl ? { url: fixtureUrl } : {}) },
  });

/** The run identity as the release gate compares it, at whichever revision this runs. */
async function identity(c: ReturnType<typeof cfg>): Promise<string> {
  const suite = await orchestrator.loadSuite(c, ROOT);
  const resolve = (orchestrator as unknown as { resolveExecution?: (c: unknown, env: string, s: unknown) => Promise<{ revision: string }> }).resolveExecution;
  return resolve ? (await resolve(c, 'staging', suite)).revision : suite.revision;
}

/** Read-only repository double: one completed, passing run for the current deployment, plus any action intents. */
function gateOrchestrator(project: ReturnType<typeof cfg>, runRevision: string, intents: unknown[] = []) {
  const db = {
    async one(sql: string) {
      if (sql.includes('from projects')) return { id: 'shop', tenant_id: 'acme', config: project };
      if (sql.includes('from deployments')) return { id: 'dep', provider_deployment_id: '42', commit_sha: 'a'.repeat(40), channel: 'default', current_deployment_id: 'dep', current_provider_deployment_id: '42', ambiguous_detail: null };
      if (sql.includes('from runs')) return { id: 'run_1', deployment_id: 'dep', environment: 'staging', suite_revision: runRevision, state: 'COMPLETED', gate: { eligible: true, reasons: [] } };
      throw new Error(`unhandled query ${sql}`);
    },
    async query(sql: string) {
      if (sql.includes('from action_intents')) return { rows: intents };
      throw new Error(`unhandled query ${sql}`);
    },
  };
  return new orchestrator.Orchestrator({ db: db as never, suiteBaseDir: ROOT, verifierFor: () => { throw new Error('unused'); }, publisherFor: () => { throw new Error('unused'); } });
}
const viewer = { tenant_id: 'acme', project_id: 'shop', role: 'viewer', actor: 'reaudit' } as never;
const gateQ = { project_id: 'shop', environment: 'staging', deployment_id: '42', commit_sha: 'a'.repeat(40) };

it('R1c: an unresolved review obligation holds the release gate even when the run itself passed', async () => {
  const c = cfg();
  const orch = gateOrchestrator(c, await identity(c), [{ intent_id: 'old.i5', run_id: 'run_1', run_attempt: 1, scenario_id: 'notes_crud', execution_profile: 'chromium_desktop', contract_intent: 'notes.delete', state: 'NEEDS_REVIEW', detail: 'not keyed', live: false }]);
  const g = await orch.gateStatus(viewer, gateQ);
  evidence('R1c', g);
  expect(g.eligible).toBe(false);
});

it('R2a: a different oracle backend is a different execution identity', async () => {
  const [a, b] = await Promise.all([identity(cfg('http://oracle-a.internal:4310')), identity(cfg('http://oracle-b.internal:4310'))]);
  evidence('R2a', { a, b });
  expect(a).not.toBe(b);
});

it('R2b: a passing run stops qualifying when only the oracle backend changes', async () => {
  const orch = gateOrchestrator(cfg('http://oracle-b.internal:4310'), await identity(cfg('http://oracle-a.internal:4310')));
  const g = await orch.gateStatus(viewer, gateQ);
  evidence('R2b', g);
  expect(g.eligible).toBe(false);
});

it('R4: a secret painted into an image resource does not survive trace sanitization', async () => {
  const token = 'tok-9f3a-SECRET-77c1';
  const page = await browser.newPage();
  let png: Buffer;
  try {
    await page.setContent(`<p style="font:24px sans-serif">API token: ${token}</p>`);
    png = await page.screenshot({ type: 'png' });
  } finally { await page.close(); }
  const s = sanitizeTraceArchive(writeZip([{ name: 'trace.trace', data: Buffer.from('{}') }, { name: 'resources/shot.png', data: png }]), [token]);
  const kept = readZip(s.bytes).find((e) => e.name === 'resources/shot.png');
  evidence('R4', { residual_hits: s.residualHits, image_retained: !!kept, image_unchanged: !!kept && kept.data.equals(png) });
  expect(kept, 'an image whose pixels may show a secret must not be published as sanitized').toBeUndefined();
});

it('R5: a qualification is not returned after its compatibility evidence has expired', async () => {
  const config = { model: 'jev-1.13.0', question_schema_version: 'q', extractor_version: 'e', policy_digest: 'p', candidate_filter_version: 'c', gate_version: 'g' };
  const band = { threshold: 0.9, accepted: 800, correct: 800, precision: 1, precision_lower: 0.9963, coverage: 0.6, precision_cluster_p05: 0.995 };
  const cal = { id: 'cal_1', decision_config: config, decision_config_digest: digestConfig(config), threshold: 0.9, target_precision: 0.99, report: { test_band: band, zero_error_samples_needed: 299 } } as unknown as CalibrationVersion;
  const profile = { project_id: 'shop', environment: 'staging', application: 'fixture-shop/2', resolved_model: 'jev-1.13.0' };
  const decided = new Date('1996-01-10T00:00:00Z');
  const record = qualify(profile, { calibration: cal, provider_compat: { ok: true, resolved_model: 'jev-1.13.0', checked_at: '1996-01-01T00:00:00Z' }, dataset: { source: 'representative', applications: ['fixture-shop/2'], labeled_decisions: 4000, double_label_agreement: 0.95 }, episodes: { attempted: 120, verified_success: 115, false_pass: 0 } }, undefined, decided);
  expect(record.state).toBe('QUALIFIED_FOR_PROFILE');
  const dir = await mkdtemp(join(tmpdir(), 'reaudit-r5-'));
  await new QualificationRegistry(dir).save(record);
  await writeFile(join(dir, 'note.txt'), 'qualified in 1996 with a 30-day compatibility window');
  const found = await new QualificationRegistry(dir).find(profile, cal);
  evidence('R5', { qualified_at: record.decided_at, found_now: !!found });
  expect(found, 'a 1996 qualification with a 30-day window must not authorize calibrated dispatch now').toBeNull();
});
