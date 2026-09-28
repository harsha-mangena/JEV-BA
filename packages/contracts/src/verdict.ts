import { z } from 'zod';

export const Verdict = z.enum(['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'NEEDS_REVIEW', 'FLAKY', 'SUPERSEDED', 'CANCELLED']);
export type Verdict = z.infer<typeof Verdict>;

export const FindingCertainty = z.enum(['suspected', 'reproduced', 'confirmed']);
export type FindingCertainty = z.infer<typeof FindingCertainty>;

/** Machine-readable reason attached to every non-PASS case verdict. */
export const ReasonCode = z.enum([
  'assertion_failed',
  'step_target_unavailable',
  'step_failed',
  'policy_denied',
  'origin_blocked',
  'auth_unavailable',
  'unsupported_capability',
  'fixture_error',
  'infrastructure_error',
  'budget_exhausted',
  'deadline_exceeded',
  'cancelled',
  'version_drift',
  'cleanup_failed',
  'no_assertions_executed',
  'autonomy_abstained',
  'provider_unavailable',
  'visual_review_required',
  /** A possibly-dispatched effect could not be established from the application; a human must inspect it. */
  'effect_unreconciled',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const RunState = z.enum(['RECEIVED', 'VALIDATING', 'WAITING_READY', 'QUEUED', 'RUNNING', 'VERIFYING', 'COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED']);
export type RunState = z.infer<typeof RunState>;

const TERMINAL: ReadonlySet<RunState> = new Set(['COMPLETED', 'ERROR', 'CANCELLED', 'SUPERSEDED']);
const FORWARD: Record<RunState, RunState | null> = {
  RECEIVED: 'VALIDATING',
  VALIDATING: 'WAITING_READY',
  WAITING_READY: 'QUEUED',
  QUEUED: 'RUNNING',
  RUNNING: 'VERIFYING',
  VERIFYING: 'COMPLETED',
  COMPLETED: null,
  ERROR: null,
  CANCELLED: null,
  SUPERSEDED: null,
};

export const isTerminal = (s: RunState) => TERMINAL.has(s);

/**
 * Lifecycle (plan §5.5): strictly forward along the happy path, or from any
 * non-terminal state into ERROR / CANCELLED / SUPERSEDED. Terminal states are
 * final; cleanup is tracked separately and does not reopen a run.
 */
export function canTransition(from: RunState, to: RunState): boolean {
  if (isTerminal(from)) return false;
  if (to === 'ERROR' || to === 'CANCELLED' || to === 'SUPERSEDED') return true;
  return FORWARD[from] === to;
}

export function transition(from: RunState, to: RunState): RunState {
  if (!canTransition(from, to)) throw new Error(`illegal run state transition ${from} -> ${to}`);
  return to;
}

export interface CaseOutcome {
  scenario_id: string;
  execution_profile: string;
  verdict: Verdict;
  critical: boolean;
  /** Configured as required for the release suite (NEEDS_REVIEW only holds when required). */
  required: boolean;
}

export interface GateResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Whether a set of case outcomes can satisfy a required release gate.
 * Every expected (scenario, profile) pair must be present — a missing case or
 * shard never turns the aggregate green.
 */
export function evaluateReleaseGate(expected: ReadonlyArray<{ scenario_id: string; execution_profile: string }>, outcomes: readonly CaseOutcome[]): GateResult {
  const reasons: string[] = [];
  if (expected.length === 0) reasons.push('no expected cases: an empty suite cannot satisfy a gate');
  const key = (o: { scenario_id: string; execution_profile: string }) => `${o.scenario_id}@${o.execution_profile}`;
  const byKey = new Map<string, CaseOutcome[]>();
  for (const o of outcomes) byKey.set(key(o), [...(byKey.get(key(o)) ?? []), o]);
  for (const e of expected) {
    const got = byKey.get(key(e));
    if (!got || got.length === 0) {
      reasons.push(`${key(e)}: missing result`);
      continue;
    }
    if (got.length > 1) {
      reasons.push(`${key(e)}: ${got.length} conflicting results`);
      continue;
    }
    const o = got[0]!;
    switch (o.verdict) {
      case 'PASS':
        break;
      case 'FLAKY':
        if (o.critical) reasons.push(`${key(e)}: FLAKY critical journey holds by default`);
        break;
      case 'NEEDS_REVIEW':
        if (o.required) reasons.push(`${key(e)}: NEEDS_REVIEW on a required check`);
        break;
      default:
        reasons.push(`${key(e)}: ${o.verdict}`);
    }
  }
  for (const k of byKey.keys()) {
    if (!expected.some((e) => key(e) === k)) reasons.push(`${k}: unexpected result not in selection manifest`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Combine attempts of one case under one contract. The first failure is
 * preserved: fail-then-pass is FLAKY, never PASS.
 */
export function combineAttempts(attempts: readonly Verdict[]): Verdict {
  if (attempts.length === 0) return 'ERROR';
  const last = attempts[attempts.length - 1]!;
  if (last === 'PASS' && attempts.slice(0, -1).some((v) => v !== 'PASS')) return 'FLAKY';
  return last;
}
