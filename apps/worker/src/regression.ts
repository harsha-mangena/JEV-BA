import { describeStep, executeStep, observe } from '@qa/browser';
import { authorizeIntent, type RiskClass, type Step } from '@qa/contracts';
import { Stop, type Driver } from './session.ts';

function riskOf(step: Step, mutation: string | undefined): RiskClass {
  if (mutation) return 'test_owned_mutation';
  if (step.op === 'navigate' || step.op === 'reload') return 'read_only';
  if (step.op === 'press') return step.key === 'Enter' || step.key === 'Space' ? 'unknown' : 'read_only';
  if (step.op === 'type' || step.op === 'select') return 'reversible_input';
  return 'unknown';
}

/** Approved deterministic steps, each authorized by policy before dispatch and never retried. */
export const regressionDriver: Driver = async (session) => {
  const { o, page, log, attemptId } = session;
  const s = o.scenario;
  let actions = 0;
  for (const m of s.milestones) {
    for (const [stepIndex, step] of m.steps.entries()) {
      session.checkpoint();
      if (++actions > s.budgets.max_actions) throw new Stop('BLOCKED', 'budget_exhausted', `exceeded ${s.budgets.max_actions} actions`);
      const auth = authorizeIntent(o.policy, s.policy.mutations, o.environment, step.intent);
      const intent = {
        intent_id: `${attemptId}.i${actions}`,
        operation: step.op,
        description: describeStep(step),
        parameter_ref: step.op === 'type' ? (step.value_ref ?? null) : step.op === 'select' ? (step.option_ref ?? null) : null,
        action_intent: step.intent ?? null,
        risk_class: riskOf(step, auth.allowed ? auth.mutation : undefined),
        milestone_id: m.id,
        step_index: stepIndex,
      };
      if (!auth.allowed) {
        log.record('intent', `denied: ${intent.description}`, { ...intent, state: 'denied', policy_decision: 'denied', reason: auth.reason });
        throw new Stop('BLOCKED', 'policy_denied', auth.reason);
      }
      log.record('intent', `persisted: ${intent.description}`, { ...intent, state: 'persisted', policy_decision: 'allowed' });
      const outcome = await executeStep(step, { page, baseUrl: o.baseUrl, timeoutMs: s.budgets.action_timeout_ms, resolveValue: session.resolveValue });
      log.record('intent', `${outcome.status}: ${intent.description}`, {
        intent_id: intent.intent_id,
        state: outcome.status === 'done' ? 'acknowledged' : outcome.status === 'not_dispatched' ? 'failed' : 'effect_unknown',
        detail: outcome.detail,
      });
      session.checkpoint();
      if (outcome.status === 'not_dispatched') {
        // Preserve what the page offered instead, so a locator repair can be proposed from evidence.
        const obs = await observe(page, { pageId: attemptId, currentMilestone: m.id }).catch(() => null);
        if (obs) await log.writeArtifact('dom', `observation-${m.id}-${stepIndex}.json`, JSON.stringify(obs, null, 2));
        throw new Stop('FAIL', outcome.reason, `${m.id}: ${intent.description}: ${outcome.detail}`);
      }
      if (outcome.status === 'effect_unknown') {
        throw new Stop('ERROR', outcome.reason, `${m.id}: ${intent.description}: input may have been dispatched; effect unknown and not retried (${outcome.detail})`);
      }
    }
    const failed = await session.verify(m);
    if (failed.length > 0) throw new Stop('FAIL', 'assertion_failed', `${m.id}: ${failed.length} of ${m.assertions.length} assertion(s) failed`);
  }
};
