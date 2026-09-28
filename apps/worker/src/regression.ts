import { actionRequestFor, describeStep, dispatchStep, observe, prepareStep } from '@qa/browser';
import { Stop, type Driver } from './session.ts';

/**
 * Approved deterministic steps. Each step is prepared (target, actionability,
 * identity) without input, authorized by the shared authorization service
 * against the trusted application contract, and only then dispatched —
 * exactly once, never retried.
 */
export const regressionDriver: Driver = async (session) => {
  const { o, page, log, attemptId } = session;
  const s = o.scenario;
  let actions = 0;
  for (const m of s.milestones) {
    for (const [stepIndex, step] of m.steps.entries()) {
      session.checkpoint();
      if (++actions > s.budgets.max_actions) throw new Stop('BLOCKED', 'budget_exhausted', `exceeded ${s.budgets.max_actions} actions`);
      const description = describeStep(step);
      const stepCtx = { page, baseUrl: o.baseUrl, timeoutMs: session.remainingMs(s.budgets.action_timeout_ms), resolveValue: session.resolveValue };
      const prep = await prepareStep(step, stepCtx);
      if (!prep.ok) {
        log.record('intent', `not dispatched: ${description}`, { intent_id: `${attemptId}.i${actions}`, milestone_id: m.id, step_index: stepIndex, state: 'failed', detail: prep.outcome.detail });
        // Preserve what the page offered instead, so a locator repair can be proposed from evidence.
        const obs = await observe(page, { pageId: attemptId, currentMilestone: m.id }).catch(() => null);
        if (obs) await log.writeArtifact('dom', `observation-${m.id}-${stepIndex}.json`, JSON.stringify(obs, null, 2));
        session.checkpoint();
        throw new Stop('FAIL', prep.outcome.status === 'not_dispatched' ? prep.outcome.reason : 'step_failed', `${m.id}: ${description}: ${prep.outcome.detail}`);
      }
      const request = actionRequestFor(prep.prepared);
      const auth = session.authorize(request);
      const intent = {
        intent_id: `${attemptId}.i${actions}`,
        operation: step.op,
        description,
        route: request.route,
        control: 'control' in request ? request.control : null,
        parameter_ref: step.op === 'type' ? (step.value_ref ?? null) : step.op === 'select' ? (step.option_ref ?? null) : null,
        action_intent: step.intent ?? null,
        effect: auth.effect,
        contract_intent: auth.intent,
        milestone_id: m.id,
        step_index: stepIndex,
      };
      if (!auth.allowed) {
        log.record('intent', `denied (${auth.code}): ${description}`, { ...intent, state: 'denied', policy_decision: 'denied', code: auth.code, reason: auth.reason });
        throw new Stop('BLOCKED', 'policy_denied', `${m.id}: ${description}: ${auth.reason}`);
      }
      const outcome = await session.dispatch({ ...intent, risk_class: auth.risk_class, mutation: auth.mutation }, () => dispatchStep(prep.prepared, stepCtx));
      session.checkpoint();
      if (outcome.status === 'not_dispatched') throw new Stop('FAIL', outcome.reason, `${m.id}: ${description}: ${outcome.detail}`);
      if (outcome.status === 'effect_unknown') {
        throw new Stop('ERROR', outcome.reason, `${m.id}: ${description}: input may have been dispatched; effect unknown and not retried (${outcome.detail})`);
      }
    }
    const failed = await session.verify(m);
    if (failed.length > 0) throw new Stop('FAIL', 'assertion_failed', `${m.id}: ${failed.length} of ${m.assertions.length} assertion(s) failed`);
  }
};
