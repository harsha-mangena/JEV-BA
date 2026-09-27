import type { CaseResult } from '@qa/contracts';
import { explorationDriver, type ExplorationOptions } from './exploration.ts';
import { regressionDriver } from './regression.ts';
import { runAttempt, Stop, type AttemptOptions } from './session.ts';

export interface CaseOptions extends AttemptOptions {
  /** Required for exploration scenarios; without it they are BLOCKED as unsupported. */
  exploration?: ExplorationOptions;
}

export async function runCaseAttempt(o: CaseOptions): Promise<CaseResult> {
  if (o.scenario.mode === 'regression') return runAttempt(o, regressionDriver);
  if (o.readOnly) return runAttempt(o, async () => Promise.reject(new Stop('BLOCKED', 'policy_denied', 'autonomous exploration is disabled in the read-only profile')));
  const exploration = o.exploration;
  return runAttempt(o, async (session) => {
    if (!exploration) throw new Stop('BLOCKED', 'unsupported_capability', 'exploration scenarios require a System One provider');
    await explorationDriver(exploration)(session);
  });
}
