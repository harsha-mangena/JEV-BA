import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
    const reg = new QualificationRegistry(await mkdtemp(join(tmpdir(), 'qa-qual-')), () => NOW);
    await reg.save(qualify(profile, evidence(), undefined, NOW));
    await reg.save(qualify({ ...profile, environment: 'production' }, evidence({ provider_compat: null }), undefined, NOW));
    expect(await reg.find(profile, cal())).not.toBeNull();
    expect(await reg.find({ ...profile, environment: 'production' }, cal())).toBeNull();
    expect(await reg.find({ ...profile, application: 'fixture-shop/3' }, cal())).toBeNull();
    expect(await reg.find(profile, cal({ id: 'cal_2' }))).toBeNull();
  });

  describe('time-bounded authorization (re-audit R5)', () => {
    const dir = () => mkdtemp(join(tmpdir(), 'qa-qual-r5-'));
    const q = () => qualify(profile, evidence(), undefined, NOW); // compat checked 2026-09-20 → expires 2026-10-20

    it('a qualification expires with its compatibility evidence: just before, it authorizes; from expiry on — decades later included — it does not', async () => {
      const r = q();
      expect(r.expires_at).toBe('2026-10-20T00:00:00.000Z');
      const at = (iso: string) => new QualificationRegistry(d, () => new Date(iso));
      const d = await dir();
      await at('2026-09-28T00:00:00Z').save(r);
      expect(await at('2026-10-19T23:59:59.999Z').find(profile, cal())).not.toBeNull();
      expect(await at('2026-10-20T00:00:00.000Z').find(profile, cal())).toBeNull();
      expect(await at('2056-09-28T00:00:00Z').find(profile, cal())).toBeNull();
    });

    it('a long-running worker re-checking the same registry loses the grant when the clock passes expiry', async () => {
      let now = new Date('2026-10-19T12:00:00Z');
      const reg = new QualificationRegistry(await dir(), () => now);
      await reg.save(q());
      expect(await reg.find(profile, cal())).not.toBeNull();
      now = new Date('2026-10-20T12:00:00Z');
      expect(await reg.find(profile, cal())).toBeNull();
    });

    it('revocation removes the grant at once, and an unreadable revocation still revokes', async () => {
      const d = await dir();
      const reg = new QualificationRegistry(d, () => NOW);
      const r = q();
      await reg.save(r);
      await expect(reg.revoke(r.id, '', 'x')).rejects.toThrow();
      await reg.revoke(r.id, 'admin:ops', 'provider incident');
      expect(await reg.find(profile, cal())).toBeNull();
      const d2 = await dir();
      const reg2 = new QualificationRegistry(d2, () => NOW);
      await reg2.save(r);
      await mkdir(join(d2, 'revocations', `${r.id}.json`), { recursive: true }); // exists but cannot be read as a file
      expect(await reg2.find(profile, cal())).toBeNull();
    });

    it('missing, corrupt or legacy (no expiry) records never authorize, and never throw', async () => {
      const d = await dir();
      const reg = new QualificationRegistry(d, () => NOW);
      expect(await new QualificationRegistry(join(d, 'absent'), () => NOW).find(profile, cal())).toBeNull();
      await writeFile(join(d, 'broken.json'), '{ not json');
      const { expires_at: _drop, ...legacy } = q();
      await writeFile(join(d, `${legacy.id}.json`), JSON.stringify(legacy));
      expect(await reg.find(profile, cal())).toBeNull();
    });

    it('renews only on current live evidence for the exact qualified model', async () => {
      let now = new Date('2026-10-25T00:00:00Z');
      const reg = new QualificationRegistry(await dir(), () => now);
      const r = q();
      await reg.save(r);
      expect(await reg.find(profile, cal())).toBeNull(); // expired on 2026-10-20
      expect(await reg.renew(r.id, { ok: true, resolved_model: 'jev-1.14.0', checked_at: '2026-10-24T00:00:00Z' })).toMatchObject({ renewed: false, reason: expect.stringMatching(/not jev-1.13.0/) });
      expect(await reg.renew(r.id, { ok: false, resolved_model: 'jev-1.13.0', checked_at: '2026-10-24T00:00:00Z' })).toMatchObject({ renewed: false });
      expect(await reg.renew(r.id, { ok: true, resolved_model: 'jev-1.13.0', checked_at: '2026-08-01T00:00:00Z' })).toMatchObject({ renewed: false, reason: expect.stringMatching(/not current/) });
      expect(await reg.find(profile, cal())).toBeNull();
      const ok = await reg.renew(r.id, { ok: true, resolved_model: 'jev-1.13.0', checked_at: '2026-10-24T00:00:00Z' });
      expect(ok).toMatchObject({ renewed: true, record: { expires_at: '2026-11-23T00:00:00.000Z' } });
      expect(await reg.find(profile, cal())).not.toBeNull();
      now = new Date('2026-11-23T00:00:00Z');
      expect(await reg.find(profile, cal())).toBeNull();
    });
  });
});
