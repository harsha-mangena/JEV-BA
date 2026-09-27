import type { GateFeatures } from '@qa/contracts';
import { isCorrect, OBSERVATION_FAILURES, type LabeledDecision } from './labels.ts';
import { logit, sigmoid } from './stats.ts';

export const FEATURE_NAMES = ['bias', 'logit_op_p', 'logit_target_p', 'op_margin', 'target_margin', 'log_candidates', 'truncated', 'recent_no_effect', 'risk_mutation', 'risk_unknown'] as const;

export function featureVector(f: GateFeatures): number[] {
  const tp = f.target_probability ?? f.op_probability;
  return [
    1,
    logit(f.op_probability),
    logit(tp),
    f.op_margin,
    f.target_margin ?? f.op_margin,
    Math.log1p(f.candidate_count),
    f.candidates_truncated ? 1 : 0,
    Math.min(f.recent_no_effect, 5),
    f.risk_class === 'test_owned_mutation' || f.risk_class === 'external_effect' ? 1 : 0,
    f.risk_class === 'unknown' ? 1 : 0,
  ];
}

export interface LogisticCalibrator {
  kind: 'logistic';
  feature_names: readonly string[];
  weights: number[];
  l2: number;
  iterations: number;
}

/**
 * L2-regularised logistic regression by full-batch gradient descent.
 * Deterministic and interpretable: one weight per named feature.
 * Observation failures are excluded from fitting (they are extraction
 * problems, not model errors) but still count as errors at evaluation.
 */
export function fitLogistic(train: LabeledDecision[], o: { l2?: number; iterations?: number; lr?: number } = {}): LogisticCalibrator {
  const data = train.filter((d) => !OBSERVATION_FAILURES.has(d.label.category));
  const X = data.map((d) => featureVector(d.features));
  const y = data.map((d) => (isCorrect(d) ? 1 : 0));
  const w = new Array<number>(FEATURE_NAMES.length).fill(0);
  const l2 = o.l2 ?? 1e-3;
  const iterations = o.iterations ?? 3000;
  const lr = o.lr ?? 0.5;
  const n = Math.max(1, X.length);
  for (let it = 0; it < iterations; it++) {
    const g = new Array<number>(w.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const x = X[i]!;
      const err = sigmoid(x.reduce((s, v, j) => s + v * w[j]!, 0)) - y[i]!;
      for (let j = 0; j < w.length; j++) g[j]! += (err * x[j]!) / n;
    }
    for (let j = 0; j < w.length; j++) w[j]! -= lr * (g[j]! + (j === 0 ? 0 : l2 * w[j]!));
  }
  return { kind: 'logistic', feature_names: FEATURE_NAMES, weights: w, l2, iterations };
}

export const predict = (c: LogisticCalibrator, f: GateFeatures) => sigmoid(featureVector(f).reduce((s, v, j) => s + v * c.weights[j]!, 0));
