import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateFeatures } from '@qa/contracts';
import { predict, type LogisticCalibrator } from './calibrator.ts';
import { cohortOf, digestConfig, type DecisionConfig, type LabeledDecision } from './labels.ts';
import { actBand, brier, cohortReports, observationFailureRate, reliability, riskCoverage, type ActBand, type CohortReport, type Scored } from './metrics.ts';
import { fitLogistic } from './calibrator.ts';
import { groupedSplit } from './split.ts';
import { zeroErrorSampleSize } from './stats.ts';

export interface CalibrationVersion {
  id: string;
  created_at: string;
  decision_config: DecisionConfig;
  decision_config_digest: string;
  calibrator: LogisticCalibrator;
  /** Null when no threshold met the target on the selection split: the gate stays advisory. */
  threshold: number | null;
  target_precision: number;
  confidence: number;
  supported_cohorts: string[];
  report: CalibrationReport;
}

export interface CalibrationReport {
  sample_counts: { total: number; fit: number; select: number; test: number; clusters_test: number };
  select_band: ActBand | null;
  test_band: ActBand | null;
  brier: number;
  ece: number;
  reliability: ReturnType<typeof reliability>['bins'];
  risk_coverage: ReturnType<typeof riskCoverage>;
  cohorts: CohortReport[];
  observation_failure_rate: number;
  zero_error_samples_needed: number;
  limitations: string[];
}

/**
 * Fit on one partition, choose the threshold on a second, and report on a
 * third held-out partition. The threshold is the lowest one whose exact
 * lower bound on the *selection* split meets the target; the test split is
 * never used for tuning.
 */
export function calibrate(data: LabeledDecision[], o: { target_precision: number; confidence?: number; decision_config: DecisionConfig; id?: string }): CalibrationVersion {
  const configs = new Set(data.map((d) => digestConfig(d.decision_config)));
  if (configs.size !== 1 || !configs.has(digestConfig(o.decision_config))) throw new Error('labeled data mixes decision configurations or does not match the requested one');
  const confidence = o.confidence ?? 0.95;
  const split = groupedSplit(data);
  const calibrator = fitLogistic(split.fit);
  const score = (xs: LabeledDecision[]): Scored[] => xs.map((d) => ({ d, p: predict(calibrator, d.features) }));
  const sel = score(split.select);
  const test = score(split.test);
  let threshold: number | null = null;
  let selectBand: ActBand | null = null;
  for (let t = 0.5; t <= 0.999; t += 0.005) {
    const b = actBand(sel, t, confidence, 0);
    if (b.accepted > 0 && b.precision_lower >= o.target_precision) {
      threshold = Number(t.toFixed(3));
      selectBand = b;
      break;
    }
  }
  const cohorts = threshold === null ? [] : cohortReports(test, threshold, o.target_precision, confidence);
  const rel = reliability(test);
  const needed = zeroErrorSampleSize(o.target_precision, confidence);
  const limitations = [
    'Bounds assume independent decisions; clustered journeys make them optimistic — see precision_cluster_p05.',
    `A ${(o.target_precision * 100).toFixed(1)}% lower bound needs at least ${needed} error-free accepted held-out actions.`,
    'Step-level precision is not journey reliability; measure end-to-end episode success separately.',
  ];
  if (threshold === null) limitations.push('No threshold met the target on the selection split: autonomy remains advisory.');
  return {
    id: o.id ?? `cal_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    created_at: new Date().toISOString(),
    decision_config: o.decision_config,
    decision_config_digest: digestConfig(o.decision_config),
    calibrator,
    threshold,
    target_precision: o.target_precision,
    confidence,
    supported_cohorts: cohorts.filter((c) => c.supported).map((c) => c.cohort),
    report: {
      sample_counts: { total: data.length, fit: split.fit.length, select: split.select.length, test: split.test.length, clusters_test: new Set(split.test.map((d) => `${d.app_id}/${d.journey_id}/${d.deployment_id}`)).size },
      select_band: selectBand,
      test_band: threshold === null ? null : actBand(test, threshold, confidence),
      brier: brier(test),
      ece: rel.ece,
      reliability: rel.bins,
      risk_coverage: riskCoverage(test),
      cohorts,
      observation_failure_rate: observationFailureRate(data),
      zero_error_samples_needed: needed,
      limitations,
    },
  };
}

export class CalibrationRegistry {
  constructor(readonly dir: string) {}

  async save(v: CalibrationVersion, makeCurrent = true): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${v.id}.json`), JSON.stringify(v, null, 2));
    if (makeCurrent) await writeFile(join(this.dir, 'current.json'), JSON.stringify({ id: v.id }));
  }

  async current(): Promise<CalibrationVersion | null> {
    try {
      const { id } = JSON.parse(await readFile(join(this.dir, 'current.json'), 'utf8')) as { id: string };
      return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as CalibrationVersion;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}

/** The calibrated stage-5 scorer the gate consumes. */
export interface CalibratedScorer {
  version_id: string;
  decision_config_digest: string;
  /** Resolved model the calibration was fitted for. */
  model?: string;
  threshold: number;
  score(f: GateFeatures): number;
  supported(f: GateFeatures): boolean;
}

export function scorerFrom(v: CalibrationVersion): CalibratedScorer | null {
  if (v.threshold === null) return null;
  const supported = new Set(v.supported_cohorts);
  return { version_id: v.id, decision_config_digest: v.decision_config_digest, model: v.decision_config.model, threshold: v.threshold, score: (f) => predict(v.calibrator, f), supported: (f) => supported.has(cohortOf({ features: f })) };
}

export interface CanaryResult {
  drift: boolean;
  reasons: string[];
  current: { precision_lower: number; ece: number };
  candidate: { precision_lower: number; ece: number };
}

/**
 * Model/prompt/extractor canary: score the candidate configuration's labeled
 * replay decisions with the current calibration and compare against the
 * current configuration's held-out results.
 */
export function canary(v: CalibrationVersion, candidateLabeled: LabeledDecision[], tolerance = { precision_drop: 0.01, ece_rise: 0.05 }): CanaryResult {
  const scored = candidateLabeled.map((d) => ({ d, p: predict(v.calibrator, d.features) }));
  const band = v.threshold === null ? null : actBand(scored, v.threshold, v.confidence, 0);
  const cand = { precision_lower: band?.precision_lower ?? 0, ece: reliability(scored).ece };
  const cur = { precision_lower: v.report.test_band?.precision_lower ?? 0, ece: v.report.ece };
  const reasons: string[] = [];
  if (candidateLabeled.some((d) => digestConfig(d.decision_config) !== v.decision_config_digest)) reasons.push('decision configuration differs from the calibrated one: re-evaluation required before autonomy');
  if (cand.precision_lower < cur.precision_lower - tolerance.precision_drop) reasons.push(`precision lower bound dropped ${cur.precision_lower.toFixed(4)} → ${cand.precision_lower.toFixed(4)}`);
  if (cand.ece > cur.ece + tolerance.ece_rise) reasons.push(`ECE rose ${cur.ece.toFixed(3)} → ${cand.ece.toFixed(3)}`);
  return { drift: reasons.length > 0, reasons, current: cur, candidate: cand };
}

/**
 * Attach the current calibration (if any) to a gate configuration. A
 * calibration that could not qualify an Act band (threshold null) still marks
 * the configuration as calibrated-without-scorer, so the gate routes every
 * decision instead of silently falling back to heuristic action.
 */
export function withCalibration<T extends { calibration_version: string | null; heuristic: boolean }>(base: T, v: CalibrationVersion | null): T & { calibrated?: CalibratedScorer } {
  if (!v) return base;
  const scorer = scorerFrom(v);
  const { calibrated: _drop, ...rest } = base as T & { calibrated?: CalibratedScorer };
  return scorer ? { ...base, calibration_version: v.id, heuristic: false, calibrated: scorer } : ({ ...rest, calibration_version: v.id, heuristic: false } as T);
}
