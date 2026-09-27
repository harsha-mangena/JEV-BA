import type { RunReport } from '@qa/contracts';
import { quantile } from './stats.ts';

export interface ArmRun {
  report: RunReport;
  /** Seeded defects active in the target for this run (ground truth). */
  defects: string[];
  /** Scenario ids whose requirements the defects violate. */
  should_fail: string[];
  cost: { s1_requests: number; s2_requests: number; browser_seconds: number };
}

export interface ArmSummary {
  arm: string;
  runs: number;
  defect_recall: number;
  false_positives: number;
  false_passes: number;
  p50_seconds: number;
  p95_seconds: number;
  verified_journeys: number;
  cost_per_verified_journey: { s1_requests: number; s2_requests: number; browser_seconds: number };
  human_review_items: number;
}

/**
 * Comparative evaluation across arms (deterministic suite, S2-only, S1
 * heuristic, S1 calibrated, hybrid) on identical fixtures and defect sets.
 * A false pass — PASS on a case whose requirement a seeded defect violates —
 * is reported separately and is the most important number here.
 */
export function summarizeArm(arm: string, runs: ArmRun[]): ArmSummary {
  let expectedFail = 0;
  let caught = 0;
  let falsePos = 0;
  let falsePass = 0;
  let verified = 0;
  let review = 0;
  const durations: number[] = [];
  const cost = { s1_requests: 0, s2_requests: 0, browser_seconds: 0 };
  for (const r of runs) {
    cost.s1_requests += r.cost.s1_requests;
    cost.s2_requests += r.cost.s2_requests;
    cost.browser_seconds += r.cost.browser_seconds;
    for (const c of r.report.cases) {
      durations.push((Date.parse(c.finished_at) - Date.parse(c.started_at)) / 1000);
      if (c.verdict === 'NEEDS_REVIEW') review++;
      if (r.should_fail.includes(c.scenario_id)) {
        expectedFail++;
        if (c.verdict !== 'PASS') caught++;
        else falsePass++;
      } else {
        if (c.verdict === 'PASS') verified++;
        else if (c.verdict === 'FAIL') falsePos++;
      }
    }
  }
  const per = (x: number) => (verified ? x / verified : Infinity);
  return {
    arm,
    runs: runs.length,
    defect_recall: expectedFail ? caught / expectedFail : NaN,
    false_positives: falsePos,
    false_passes: falsePass,
    p50_seconds: quantile(durations, 0.5),
    p95_seconds: quantile(durations, 0.95),
    verified_journeys: verified,
    cost_per_verified_journey: { s1_requests: per(cost.s1_requests), s2_requests: per(cost.s2_requests), browser_seconds: per(cost.browser_seconds) },
    human_review_items: review,
  };
}
