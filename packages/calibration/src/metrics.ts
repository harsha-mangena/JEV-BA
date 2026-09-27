import { isCorrect, OBSERVATION_FAILURES, cohortOf, type LabeledDecision } from './labels.ts';
import { clusterOf } from './split.ts';
import { clopperPearsonLower, quantile, rng } from './stats.ts';

export interface Scored {
  d: LabeledDecision;
  p: number;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  mean_predicted: number;
  observed_accuracy: number;
}

export function brier(xs: Scored[]): number {
  return xs.reduce((s, x) => s + (x.p - (isCorrect(x.d) ? 1 : 0)) ** 2, 0) / Math.max(1, xs.length);
}

export function reliability(xs: Scored[], bins = 10): { bins: ReliabilityBin[]; ece: number } {
  const out: ReliabilityBin[] = [];
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = xs.filter((x) => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!inBin.length) continue;
    const mp = inBin.reduce((s, x) => s + x.p, 0) / inBin.length;
    const acc = inBin.filter((x) => isCorrect(x.d)).length / inBin.length;
    out.push({ lo, hi, n: inBin.length, mean_predicted: mp, observed_accuracy: acc });
    ece += (inBin.length / xs.length) * Math.abs(mp - acc);
  }
  return { bins: out, ece };
}

export interface ActBand {
  threshold: number;
  accepted: number;
  correct: number;
  precision: number;
  precision_lower: number;
  coverage: number;
  /** Cluster bootstrap (by app/journey/deployment) 5th percentile of precision. */
  precision_cluster_p05: number;
}

export function actBand(xs: Scored[], threshold: number, confidence = 0.95, bootstrap = 400): ActBand {
  const acc = xs.filter((x) => x.p >= threshold);
  const correct = acc.filter((x) => isCorrect(x.d)).length;
  const clusters = new Map<string, Scored[]>();
  for (const x of acc) clusters.set(clusterOf(x.d), [...(clusters.get(clusterOf(x.d)) ?? []), x]);
  const keys = [...clusters.keys()];
  const r = rng(42);
  const boots: number[] = [];
  for (let b = 0; b < bootstrap && keys.length; b++) {
    let n = 0;
    let c = 0;
    for (let i = 0; i < keys.length; i++) {
      const pick = clusters.get(keys[Math.floor(r() * keys.length)]!)!;
      n += pick.length;
      c += pick.filter((x) => isCorrect(x.d)).length;
    }
    boots.push(n ? c / n : 0);
  }
  return {
    threshold,
    accepted: acc.length,
    correct,
    precision: acc.length ? correct / acc.length : NaN,
    precision_lower: clopperPearsonLower(correct, acc.length, confidence),
    coverage: xs.length ? acc.length / xs.length : 0,
    precision_cluster_p05: boots.length ? quantile(boots, 0.05) : NaN,
  };
}

/** Risk (1 − precision) against coverage across thresholds. */
export function riskCoverage(xs: Scored[], steps = 20): Array<{ threshold: number; coverage: number; risk: number }> {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const acc = xs.filter((x) => x.p >= t);
    return { threshold: t, coverage: xs.length ? acc.length / xs.length : 0, risk: acc.length ? 1 - acc.filter((x) => isCorrect(x.d)).length / acc.length : 0 };
  });
}

export interface CohortReport {
  cohort: string;
  n: number;
  accepted: number;
  precision_lower: number;
  supported: boolean;
}

/** Cohorts (risk class × operation) without enough held-out evidence are forced to fall back. */
export function cohortReports(xs: Scored[], threshold: number, target: number, confidence = 0.95): CohortReport[] {
  const by = new Map<string, Scored[]>();
  for (const x of xs) by.set(cohortOf(x.d), [...(by.get(cohortOf(x.d)) ?? []), x]);
  return [...by].map(([cohort, items]) => {
    const band = actBand(items, threshold, confidence, 0);
    return { cohort, n: items.length, accepted: band.accepted, precision_lower: band.precision_lower, supported: band.accepted > 0 && band.precision_lower >= target };
  });
}

export function observationFailureRate(data: LabeledDecision[]): number {
  return data.length ? data.filter((d) => OBSERVATION_FAILURES.has(d.label.category)).length / data.length : 0;
}
