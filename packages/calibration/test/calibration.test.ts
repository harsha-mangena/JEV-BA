import { describe, expect, it } from 'vitest';
import type { GateFeatures } from '@qa/contracts';
import {
  actBand,
  agreement,
  calibrate,
  canary,
  clopperPearsonLower,
  cohortOf,
  digestConfig,
  groupedSplit,
  journeySuccess,
  logit,
  rng,
  scorerFrom,
  sigmoid,
  summarizeArm,
  zeroErrorSampleSize,
  type DecisionConfig,
  type LabeledDecision,
} from '../src/index.ts';

const CONFIG: DecisionConfig = { model: 'jev-1.13@2026-09-01', question_schema_version: 'questions-v1', extractor_version: 'observe-v1', policy_digest: 'p', candidate_filter_version: 'candidates-v1', gate_version: 'heuristic-v0' };

/**
 * Synthetic workload with a known truth: the model is overconfident, so the
 * true probability of a correct action is sigmoid(0.6·logit(p) − 0.4) and
 * lower still for mutations.
 */
function synth(n: number, seed: number, degrade = 0, config = CONFIG): LabeledDecision[] {
  const r = rng(seed);
  const out: LabeledDecision[] = [];
  for (let i = 0; i < n; i++) {
    const op_p = 0.5 + 0.5 * r();
    const t_p = 0.3 + 0.7 * r() ** 0.5;
    const risk = r() < 0.3 ? 'test_owned_mutation' : 'reversible_input';
    const truth = sigmoid(0.6 * logit(t_p) + 0.5 * logit(op_p) + 1.2 - (risk === 'test_owned_mutation' ? 0.5 : 0) - degrade);
    const features: GateFeatures = {
      op: 'CLICK', op_probability: op_p, op_margin: 2 * op_p - 1, target_probability: t_p, target_margin: Math.max(0, 2 * t_p - 1), pair_score: op_p * t_p,
      provider_confidence: null, candidate_count: 3 + Math.floor(r() * 20), candidates_truncated: false, argument_valid: true, fresh: true, risk_class: risk, recent_no_effect: 0,
    };
    const absent = r() < 0.02;
    out.push({
      decision_id: `d${seed}-${i}`,
      app_id: `app${i % 3}`,
      journey_id: `j${Math.floor(i / 8)}`,
      deployment_id: `dep${Math.floor(i / 40)}`,
      decision_config: config,
      features,
      label: { category: absent ? 'correct_target_absent' : r() < truth ? 'correct' : 'wrong_target', valid_alternatives: [] },
      annotations: [],
      adjudicated: false,
    });
  }
  return out;
}

describe('exact bounds (plan §9.2)', () => {
  it('matches the zero-error closed form and required sample sizes', () => {
    expect(clopperPearsonLower(200, 200)).toBeCloseTo(0.9851, 4);
    expect(clopperPearsonLower(500, 500)).toBeCloseTo(0.994, 4);
    expect(zeroErrorSampleSize(0.99)).toBe(299);
    expect(zeroErrorSampleSize(0.999)).toBe(2995);
    expect(clopperPearsonLower(299, 299)).toBeGreaterThanOrEqual(0.99);
    expect(clopperPearsonLower(298, 298)).toBeLessThan(0.99);
    expect(journeySuccess(0.99, 50)).toBeCloseTo(0.605, 3);
  });

  it('is conservative and monotone with errors', () => {
    const a = clopperPearsonLower(95, 100);
    expect(a).toBeGreaterThan(0.88);
    expect(a).toBeLessThan(0.95);
    expect(clopperPearsonLower(94, 100)).toBeLessThan(a);
    expect(clopperPearsonLower(0, 10)).toBe(0);
  });
});

describe('grouped splits', () => {
  it('never splits a cluster across partitions', () => {
    const data = synth(2000, 1);
    const s = groupedSplit(data);
    const where = new Map<string, string>();
    for (const [name, xs] of Object.entries(s)) for (const d of xs) {
      const k = `${d.app_id}/${d.journey_id}/${d.deployment_id}`;
      expect(where.get(k) ?? name).toBe(name);
      where.set(k, name);
    }
    expect(s.fit.length).toBeGreaterThan(700);
    expect(s.test.length).toBeGreaterThan(300);
  });
});

describe('calibration', () => {
  const data = synth(6000, 7);
  const v = calibrate(data, { target_precision: 0.95, decision_config: CONFIG, id: 'cal_test' });

  it('produces calibrated held-out probabilities and a threshold chosen without the test split', () => {
    expect(v.report.ece).toBeLessThan(0.05);
    expect(v.threshold).not.toBeNull();
    expect(v.report.select_band!.precision_lower).toBeGreaterThanOrEqual(0.95);
    expect(v.report.test_band!.precision).toBeGreaterThan(0.93);
    expect(v.report.test_band!.coverage).toBeGreaterThan(0);
    expect(v.report.sample_counts.test).toBeGreaterThan(0);
    expect(v.report.limitations.join(' ')).toMatch(/not journey reliability/);
    expect(v.report.observation_failure_rate).toBeGreaterThan(0);
  });

  it('forces fallback in cohorts without enough held-out evidence', () => {
    expect(v.report.cohorts.length).toBeGreaterThan(0);
    for (const c of v.report.cohorts) expect(c.supported).toBe(c.accepted > 0 && c.precision_lower >= 0.95);
    const scorer = scorerFrom(v)!;
    const rareCohort = { ...data[0]!.features, risk_class: 'external_effect' as const };
    expect(scorer.supported(rareCohort)).toBe(false);
    expect(v.supported_cohorts).not.toContain(cohortOf({ features: rareCohort }));
  });

  it('stays advisory when the target cannot be demonstrated', () => {
    const small = calibrate(synth(120, 3), { target_precision: 0.999, decision_config: CONFIG });
    expect(small.threshold).toBeNull();
    expect(scorerFrom(small)).toBeNull();
    expect(small.report.limitations.join(' ')).toMatch(/advisory/);
  });

  it('refuses to mix decision configurations', () => {
    const mixed = [...synth(100, 1), ...synth(100, 2, 0, { ...CONFIG, model: 'other' })];
    expect(() => calibrate(mixed, { target_precision: 0.9, decision_config: CONFIG })).toThrow(/mixes decision configurations/);
  });

  it('a canary flags a changed configuration and a degraded model', () => {
    expect(canary(v, synth(3000, 11)).drift).toBe(false);
    const worse = canary(v, synth(3000, 12, 1.5));
    expect(worse.drift).toBe(true);
    expect(worse.reasons.join()).toMatch(/precision lower bound dropped/);
    expect(canary(v, synth(500, 13, 0, { ...CONFIG, extractor_version: 'observe-v2' })).reasons.join()).toMatch(/re-evaluation required/);
    expect(digestConfig(CONFIG)).toBe(v.decision_config_digest);
  });

  it('reports cluster-aware uncertainty alongside the exact bound', () => {
    const b = actBand(data.map((d) => ({ d, p: 0.99 })), 0.5);
    expect(b.precision_cluster_p05).toBeLessThanOrEqual(b.precision);
  });

  it('measures annotator agreement', () => {
    const d = synth(3, 1);
    d[0]!.annotations = [{ annotator: 'a', category: 'correct' }, { annotator: 'b', category: 'correct' }];
    d[1]!.annotations = [{ annotator: 'a', category: 'correct' }, { annotator: 'b', category: 'wrong_target' }];
    expect(agreement(d)).toEqual({ multiply_annotated: 2, unanimous: 1, rate: 0.5 });
  });
});

describe('comparative experiments', () => {
  it('separates recall, false positives and false passes', () => {
    const c = (id: string, verdict: string) => ({ scenario_id: id, verdict, started_at: '2026-09-27T00:00:00Z', finished_at: '2026-09-27T00:00:05Z' });
    const report = (cases: unknown[]) => ({ cases }) as never;
    const s = summarizeArm('s1-heuristic', [
      { report: report([c('checkout', 'FAIL'), c('notes', 'PASS')]), defects: ['total_off_by_one'], should_fail: ['checkout'], cost: { s1_requests: 10, s2_requests: 1, browser_seconds: 10 } },
      { report: report([c('checkout', 'PASS'), c('notes', 'FAIL')]), defects: ['checkout_double_submit'], should_fail: ['checkout'], cost: { s1_requests: 10, s2_requests: 0, browser_seconds: 10 } },
    ]);
    expect(s).toMatchObject({ defect_recall: 0.5, false_passes: 1, false_positives: 1, verified_journeys: 1, p50_seconds: 5 });
    expect(s.cost_per_verified_journey.s1_requests).toBe(20);
  });
});
