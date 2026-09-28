import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestConfig, qualify, QualificationRegistry, type CalibrationVersion, type QualificationEvidence, type QualificationProfile } from '../src/index.ts';

const config = { model: 'jev-1.13.0', question_schema_version: 'questions-v1', extractor_version: 'observe-v2', policy_digest: 'p', candidate_filter_version: 'candidates-v1', gate_version: 'heuristic-v0' };
const band = { threshold: 0.9, accepted: 800, correct: 800, precision: 1, precision_lower: 0.9963, coverage: 0.6, precision_cluster_p05: 0.995 };
const cal = (over: Partial<CalibrationVersion> = {}): CalibrationVersion =>
  ({
    id: 'cal_1',
    created_at: '2026-09-01T00:00:00Z',
    decision_config: config,
    decision_config_digest: digestConfig(config),
    calibrator: { weights: [], bias: 0 },
    threshold: 0.9,
    target_precision: 0.99,
    confidence: 0.95,
    supported_cohorts: ['all'],
    report: { sample_counts: { total: 4000, fit: 2000, select: 1000, test: 1000, clusters_test: 40 }, select_band: band, test_band: band, brier: 0.05, ece: 0.02, reliability: [], risk_coverage: [], cohorts: [], observation_failure_rate: 0.01, zero_error_samples_needed: 299, limitations: [] },
    ...over,
  }) as unknown as CalibrationVersion;
const profile: QualificationProfile = { project_id: 'shop', environment: 'staging', application: 'fixture-shop/2', resolved_model: 'jev-1.13.0' };
const evidence = (over: Partial<QualificationEvidence> = {}): QualificationEvidence => ({
  calibration: cal(),
  provider_compat: { ok: true, resolved_model: 'jev-1.13.0', checked_at: '2026-09-20T00:00:00Z' },
  dataset: { source: 'representative', applications: ['fixture-shop/2'], labeled_decisions: 4000, double_label_agreement: 0.95 },
  episodes: { attempted: 120, verified_success: 115, false_pass: 0 },
  ...over,
});
const NOW = new Date('2026-09-28T00:00:00Z');

describe('calibration qualification (completion phase 11)', () => {
  it('qualifies only a complete, representative, live-verified profile', () => {
    expect(qualify(profile, evidence(), undefined, NOW)).toMatchObject({ state: 'QUALIFIED_FOR_PROFILE', reasons: [] });
  });

  it('blocks on every missing or weak element and says why', () => {
    const r = qualify(profile, evidence({ calibration: cal({ threshold: null }), dataset: { source: 'fixture', applications: ['other/1'], labeled_decisions: 50, double_label_agreement: null }, episodes: { attempted: 10, verified_success: 5, false_pass: 1 } }), undefined, NOW);
    expect(r.state).toBe('BLOCKED');
    expect(r.reasons.join(' | ')).toMatch(/no Act band.*fixture, not representative.*does not include application.*label audit.*end-to-end episodes/);
    expect(qualify({ ...profile, resolved_model: 'jev-1.14.0' }, evidence({ provider_compat: { ok: true, resolved_model: 'jev-1.14.0', checked_at: '2026-09-20T00:00:00Z' } }), undefined, NOW).reasons).toContain('calibration was fitted for model jev-1.13.0, not jev-1.14.0');
    const thin = cal({ report: { ...cal().report, test_band: { ...band, accepted: 120 } } });
    expect(qualify(profile, evidence({ calibration: thin }), undefined, NOW).reasons.join()).toMatch(/only 120 accepted held-out decisions/);
    expect(qualify(profile, evidence({ episodes: { attempted: 120, verified_success: 119, false_pass: 1 } }), undefined, NOW).state).toBe('BLOCKED');
  });

  it('requires live verification that is current and names the same model', () => {
    expect(qualify(profile, evidence({ provider_compat: null }), undefined, NOW)).toMatchObject({ state: 'LIVE_VERIFICATION_REQUIRED' });
    expect(qualify(profile, evidence({ provider_compat: { ok: true, resolved_model: 'jev-1.13.0', checked_at: '2026-07-01T00:00:00Z' } }), undefined, NOW).reasons.join()).toMatch(/days old/);
    expect(qualify(profile, evidence({ provider_compat: { ok: true, resolved_model: 'jev-1.12.0', checked_at: '2026-09-20T00:00:00Z' } }), undefined, NOW).state).toBe('LIVE_VERIFICATION_REQUIRED');
  });

  it('the registry grants a calibration only for its exact qualified profile', async () => {
    const reg = new QualificationRegistry(await mkdtemp(join(tmpdir(), 'qa-qual-')));
    await reg.save(qualify(profile, evidence(), undefined, NOW));
    await reg.save(qualify({ ...profile, environment: 'production' }, evidence({ provider_compat: null }), undefined, NOW));
    expect(await reg.find(profile, cal())).not.toBeNull();
    expect(await reg.find({ ...profile, environment: 'production' }, cal())).toBeNull();
    expect(await reg.find({ ...profile, application: 'fixture-shop/3' }, cal())).toBeNull();
    expect(await reg.find(profile, cal({ id: 'cal_2' }))).toBeNull();
  });
});
