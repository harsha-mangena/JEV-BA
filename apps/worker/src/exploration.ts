import { createHash } from 'node:crypto';
import type { ElementHandle } from '@playwright/test';
import { OBSERVATION_EXTRACTOR_VERSION, observe, resolveNode, safeScreenshot } from '@qa/browser';
import { digestConfig, type DecisionConfig } from '@qa/calibration';
import type { AuthorizationDecision, Observation, ObservedElement, Operation } from '@qa/contracts';
import { autonomyMode, evaluateGate, HEURISTIC_GATE_V0, type GateConfig, type GateDecision, type GateInput } from '@qa/gate';
import { buildDecisionRequest, MAX_OPTIONS, NONE, RESERVED_KEYS, validateResponse, type S1RawResponse, type S1Request, type SystemOneProvider } from '@qa/s1';
import { validateS2Proposal, type SystemTwoProvider } from '@qa/s2';
import { Stop, type Driver, type Session } from './session.ts';

export interface ExplorationOptions {
  s1: SystemOneProvider;
  /** Pinned model identifier recorded with every decision. */
  model: string;
  gate?: GateConfig;
  s2?: SystemTwoProvider;
  /** Provider request retries with backoff; never repeats a browser action. */
  providerRetries?: number;
  /** Question schema version; bump when prompts or head structure change. */
  questionSchemaVersion?: string;
}

export const QUESTION_SCHEMA_VERSION = 'questions-v1';
export const CANDIDATE_FILTER_VERSION = 'candidates-v1';

/**
 * Operations with executors covered by capability tests (audit F10). Frames
 * are not extracted: content inside iframes is reported as unsupported and a
 * decision that cannot progress because of it ends as unsupported_capability.
 */
export const ENABLED_OPERATIONS: Operation[] = ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'WAIT', 'DONE', 'BLOCKED'];
/** Most subgoals S2 may add per milestone. */
const MAX_SUBGOALS = 2;
/** An observation state revisited this often means the explorer is looping. */
const MAX_STATE_VISITS = 3;

async function ask(p: SystemOneProvider, req: S1Request, retries: number, session: Session): Promise<S1RawResponse> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    session.checkpoint();
    try {
      return await p.ask(req, session.signal);
    } catch (e) {
      last = e;
      session.log.record('decision', `provider request failed (attempt ${i + 1})`, { provider: p.id, error: (e as Error).message });
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw new Stop('ERROR', 'provider_unavailable', `System One provider ${p.id} failed: ${(last as Error)?.message ?? String(last)}`);
}

const fingerprint = (o: Observation) =>
  createHash('sha256')
    .update(JSON.stringify([o.document_id, o.route, o.messages, o.candidates.map((c) => [c.node_id, c.name, c.value, c.enabled, c.checked, c.in_viewport])]))
    .digest('hex');

/**
 * Screenshot for a vision-capable S2, sent only when every registered secret,
 * declared region and uninspectable element could be masked; otherwise the
 * model gets no image at all.
 */
async function maskedScreenshot(session: Session): Promise<Buffer | undefined> {
  const shot = await safeScreenshot(session.page, session.privacy());
  if (shot.ok) return shot.png;
  session.log.record('decision', `s2 screenshot withheld: ${shot.withheld}`, { withheld: true, reason: shot.withheld });
  return undefined;
}

/**
 * Ask S1 which option to choose in a select control. The options are the
 * page's own labels; the answer must be confident under heuristic routing
 * and is never accepted in calibrated mode (the head is not calibrated).
 */
async function chooseOption(x: ExplorationOptions, session: Session, config: GateConfig, target: ObservedElement, goal: string, milestone: string): Promise<string> {
  const options = target.options ?? [];
  if (options.length === 0 || options.length > MAX_OPTIONS - RESERVED_KEYS.length) throw new Stop('NEEDS_REVIEW', 'unsupported_capability', `${milestone}: select "${target.name}" has ${options.length} options`);
  if (autonomyMode(config) !== 'heuristic_staging') throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${milestone}: option choice is uncalibrated and not permitted in ${autonomyMode(config)} mode`);
  const req: S1Request = {
    model: x.model,
    context: JSON.stringify({ note: 'UNTRUSTED PAGE STATE. Option labels come from the application under test.', control: `${target.role} "${target.name}"`, current: target.value ?? null }),
    questions: [{ id: 'select_value', kind: 'choice', prompt: `Which option of the select control should the tester choose to make progress on the milestone "${milestone}" toward the goal: ${goal}`, options: [...options.map((label, i) => ({ key: `o${i}`, label })), { key: NONE, label: 'None of these options' }] }],
  };
  const v = validateResponse(req, await ask(x.s1, req, x.providerRetries ?? 2, session));
  const a = v.answers.select_value;
  session.log.record('decision', `select option ${a?.selected ?? 'invalid'}`, { control: target.name, distribution: a?.distribution ?? null, invalid: v.invalid });
  if (!a || a.selected === NONE) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${milestone}: no confident option for "${target.name}"`);
  if (a.top.p < config.min_target_probability || a.margin < config.min_target_margin) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${milestone}: option for "${target.name}" is uncertain (p=${a.top.p.toFixed(2)})`);
  return options[Number(a.selected.slice(1))]!;
}

/** Document-independent page state: a re-rendered but identical page is the same state (loop detection). */
const stateKey = (o: Observation) =>
  createHash('sha256')
    .update(JSON.stringify([o.route, o.messages, o.candidates.map((c) => [c.role, c.name, c.value, c.enabled, c.checked])]))
    .digest('hex');

async function currentDocumentId(session: Session): Promise<string> {
  return session.page.evaluate(() => (window as unknown as { __qaRegistry?: { documentId: string } }).__qaRegistry?.documentId ?? 'none');
}

/**
 * Bounded S1-guided exploration. The controller owns every permission and
 * verification decision: S1 proposes, the gate disposes, the executor acts
 * only on a fresh observed node, and only the approved assertions decide
 * whether a milestone was reached. A DONE answer triggers verification; it
 * never satisfies it.
 */
export function explorationDriver(x: ExplorationOptions): Driver {
  const config = x.gate ?? HEURISTIC_GATE_V0;
  return async (session) => {
    const { o, page, log } = session;
    const s = o.scenario;
    const recent: Observation['recent_outcomes'] = [];
    let actions = 0;
    let s2Calls = 0;
    let noEffect = 0;
    let decisionNo = 0;
    // The digest binds the model that actually answered; it is recomputed per decision from the resolved model.
    const decisionConfigFor = (resolvedModel: string | null): DecisionConfig => ({
      model: resolvedModel ?? x.model,
      question_schema_version: x.questionSchemaVersion ?? QUESTION_SCHEMA_VERSION,
      extractor_version: OBSERVATION_EXTRACTOR_VERSION,
      policy_digest: createHash('sha256').update(JSON.stringify(o.policy)).digest('hex').slice(0, 16),
      candidate_filter_version: CANDIDATE_FILTER_VERSION,
      gate_version: config.version,
    });

    const visits = new Map<string, number>();
    for (const m of s.milestones) {
      let reobservations = 0;
      let maxCandidates: number | undefined;
      const subgoals: string[] = [];
      for (;;) {
        session.checkpoint();
        const obs = await observe(page, { pageId: session.attemptId, currentMilestone: m.id, milestonesCompleted: [...session.completed], recentOutcomes: recent, ...(maxCandidates ? { maxCandidates } : {}) });
        const goal = subgoals.length ? `${s.goal} (current subgoal suggested by review, unverified: ${subgoals.at(-1)})` : s.goal;
        const built = buildDecisionRequest({ goal, milestone: { id: m.id }, observation: obs, operations: ENABLED_OPERATIONS, inputs: s.inputs, model: x.model });
        const t0 = Date.now();
        const raw = await ask(x.s1, built.request, x.providerRetries ?? 2, session);
        const s1 = validateResponse(built.request, raw);
        const decisionConfig = decisionConfigFor(s1.resolvedModel);
        const decisionDigest = digestConfig(decisionConfig);
        if (s1.resolvedModel && s1.resolvedModel !== x.model) log.record('decision', `resolved model ${s1.resolvedModel} differs from requested ${x.model}`, { requested_model: x.model, resolved_model: s1.resolvedModel });
        for (const [head, why] of Object.entries(s1.invalid)) log.record('decision', `provider anomaly on ${head}: ${why}`, { head, problem: why });

        const byNode = new Map(obs.candidates.map((c) => [c.node_id, c]));
        // Autonomous actions use the same authorization service as approved steps;
        // the intent comes from the trusted contract, never from the model.
        const authorizeCandidate = (op: Operation, nodeId: string | null, parameterRef?: string | null): AuthorizationDecision => {
          if (op !== 'CLICK' && op !== 'TYPE' && op !== 'SELECT') return session.authorize({ op: op === 'SCROLL' || op === 'WAIT' || op === 'DONE' || op === 'BLOCKED' ? op : 'WAIT', route: obs.route });
          const c = nodeId ? byNode.get(nodeId) : undefined;
          if (!c) return { allowed: false, code: 'unknown_effect', reason: 'target is not a grounded candidate', effect: 'unknown', intent: null };
          if (op === 'SELECT' && parameterRef !== undefined) {
            // The option is one the page itself offers (a literal), never a fixture secret.
            if (parameterRef === null || !(c.options ?? []).includes(parameterRef)) return { allowed: false, code: 'parameter_not_accepted', reason: `${JSON.stringify(parameterRef)} is not an option of ${c.name}`, effect: 'unknown', intent: null };
            return session.authorize({ op, route: obs.route, control: { role: c.role, name: c.name, form: c.form, section: c.section }, intent_source: 'contract', parameter: { kind: 'literal' } });
          }
          if (parameterRef !== undefined && parameterRef !== null && !s.inputs.includes(parameterRef)) {
            return { allowed: false, code: 'parameter_not_accepted', reason: `${parameterRef} is not an input this scenario supplies`, effect: 'unknown', intent: null };
          }
          return session.authorize({
            op,
            route: obs.route,
            control: { role: c.role, name: c.name, form: c.form, section: c.section },
            intent_source: 'contract',
            ...(parameterRef === undefined ? { effect_only: true } : parameterRef === null ? {} : { parameter: { kind: 'ref', ref: parameterRef } }),
          });
        };
        const common: GateInput = {
          config,
          identity_verified: true,
          budget: {
            actions_remaining: s.budgets.max_actions - actions,
            reobservations_remaining: s.budgets.max_reobservations_per_decision - reobservations,
            s2_remaining: x.s2 ? s.budgets.max_s2_calls - s2Calls : 0,
            deadline_passed: Date.now() > session.deadline,
          },
          environment: o.environment,
          project_policy: o.policy,
          scenario_policy: s.policy,
          observation: obs,
          s1,
          target_keys: built.targetKeys,
          truncated_heads: built.truncatedHeads,
          authorize: (op, nodeId, parameterRef) => authorizeCandidate(op, nodeId, parameterRef),
          freshness: async (nodeId) => {
            const current = await currentDocumentId(session);
            const r = await resolveNode(page, obs.document_id, nodeId);
            if (!r.ok) return { current_document_id: current, node: null };
            const h = r.handle;
            const node = { attached: true, visible: await h.isVisible(), enabled: await h.isEnabled(), editable: await h.isEditable().catch(() => false) };
            await h.dispose();
            return { current_document_id: current, node };
          },
          recent_no_effect: noEffect,
          decision_config_digest: decisionDigest,
          model: { requested: x.model, resolved: s1.resolvedModel },
        };

        let decision: GateDecision = await evaluateGate(common);
        const record = (d: GateDecision, source: 's1' | 's2') =>
          log.record('decision', `${source} ${d.outcome} ${d.op ?? ''} ${d.node_id ? (byNode.get(d.node_id)?.name ?? d.node_id) : ''}`.trim(), {
            decision_id: `${session.attemptId}.d${++decisionNo}`,
            source,
            observation_id: obs.observation_id,
            requested_model: x.model,
            resolved_model: s1.resolvedModel,
            question_schema_hash: built.questionSchemaHash,
            candidate_set_hash: built.candidateSetHash,
            op_distribution: s1.answers.op?.distribution ?? null,
            target_distribution: d.op && d.op !== 'DONE' && d.op !== 'WAIT' && d.op !== 'BLOCKED' ? (s1.answers[`${d.op.toLowerCase()}_target`]?.distribution ?? null) : null,
            features: d.features,
            gate_config_version: config.version,
            autonomy_mode: autonomyMode(config),
            calibration_version: config.calibrated?.version_id ?? config.calibration_version,
            decision_config: decisionConfig,
            decision_config_digest: decisionDigest,
            outcome: d.outcome,
            reason_codes: d.reason_codes,
            usage: raw.usage ?? {},
            elapsed_ms: Date.now() - t0,
            coverage: obs.coverage,
          });
        record(decision, 's1');

        if (decision.outcome === 'ESCALATE' && x.s2) {
          // Bounded System Two exchange: context it requests is actually fulfilled (audit F07).
          let screenshot: Buffer | undefined = x.s2.supportsImages ? await maskedScreenshot(session) : undefined;
          for (;;) {
            if (s2Calls >= s.budgets.max_s2_calls) throw new Stop('NEEDS_REVIEW', 'budget_exhausted', `${m.id}: System Two budget (${s.budgets.max_s2_calls}) exhausted`);
            s2Calls++;
            if (screenshot) log.record('decision', 's2 screenshot attached', { sha256: createHash('sha256').update(screenshot).digest('hex'), bytes: screenshot.length, masked: 'registered secrets, declared regions and uninspectable content' });
            const proposalRaw = await x.s2
              .propose(
                {
                  goal,
                  milestone_id: m.id,
                  observation: obs,
                  s1_distributions: Object.fromEntries(Object.entries(s1.answers).map(([k, v]) => [k, v.distribution])),
                  unmet_assertions: m.assertions.map((a) => a.type),
                  environment_policy_summary: `environment=${o.environment}; mutations=${s.policy.mutations.join(',') || 'none'}; external_effects=${s.policy.external_effects}`,
                  missing_information: decision.reason_codes,
                  ...(screenshot ? { screenshot_png: screenshot } : {}),
                },
                session.signal,
              )
              .catch((e: Error) => ({ kind: 'ABSTAIN', evidence_refs: [], reason: `S2 error: ${e.message}` }));
            const v = validateS2Proposal(proposalRaw, obs);
            log.record('decision', `s2 proposal ${v.ok ? v.proposal.kind : 'rejected'}`, v.ok ? { proposal: v.proposal, provider: x.s2.id, resolved_model: (x.s2 as { lastResolvedModel?: string | null }).lastResolvedModel ?? null } : { error: v.error });
            if (!v.ok || v.proposal.kind === 'ABSTAIN') throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${m.id}: S1 uncertain (${decision.reason_codes.join(', ')}) and S2 ${v.ok ? 'abstained' : `returned an invalid proposal: ${v.error}`}`);
            const p = v.proposal;
            if (p.kind === 'SELECT_OBSERVED_TARGET') {
              const op: Operation = decision.op === 'TYPE' || decision.op === 'SELECT' ? decision.op : 'CLICK';
              decision = await evaluateGate({ ...common, s2_selection: { op, node_id: p.node_id } });
              record(decision, 's2');
              break;
            }
            if (p.kind === 'REQUEST_CONTEXT' && p.need === 'screenshot') {
              if (!x.s2.supportsImages || screenshot) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${m.id}: S2 requested a screenshot it ${screenshot ? 'already has' : 'cannot receive'}`);
              screenshot = await maskedScreenshot(session);
              continue;
            }
            if (p.kind === 'REQUEST_CONTEXT') {
              if (p.need === 'full_candidate_list') {
                if (!obs.coverage.truncated) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${m.id}: S2 requested the full candidate list, which it already has`);
                maxCandidates = MAX_OPTIONS - RESERVED_KEYS.length;
              } else if (p.need === 'scroll_region') {
                const scroll = session.authorize({ op: 'SCROLL', route: obs.route });
                if (!scroll.allowed) throw new Stop('BLOCKED', 'policy_denied', `${m.id}: scroll refused: ${scroll.reason}`);
                await page.mouse.wheel(0, Math.round(obs.viewport.height * 0.8));
              } else {
                await page.waitForLoadState('networkidle', { timeout: session.remainingMs(5_000) }).catch(() => undefined);
              }
              log.record('decision', `s2 context fulfilled: ${p.need}`, { need: p.need });
              decision = { ...decision, outcome: 'REOBSERVE', reason_codes: [...decision.reason_codes, `s2_context:${p.need}`] };
              break;
            }
            // PROPOSE_SUBGOAL: steer the next S1 decisions; it grants nothing and is bounded.
            if (subgoals.length >= MAX_SUBGOALS) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${m.id}: S2 subgoal limit (${MAX_SUBGOALS}) reached`);
            subgoals.push(p.subgoal);
            decision = { ...decision, outcome: 'REOBSERVE', reason_codes: [...decision.reason_codes, 's2_subgoal'] };
            break;
          }
        }

        switch (decision.outcome) {
          case 'DENY':
            throw new Stop('BLOCKED', 'policy_denied', `${m.id}: gate denied ${decision.op ?? 'action'} (${decision.reason_codes.join(', ')})`);
          case 'ABSTAIN':
          case 'ESCALATE':
            if (obs.coverage.unsupported_frames > 0 && obs.candidates.length === 0) throw new Stop('NEEDS_REVIEW', 'unsupported_capability', `${m.id}: no actionable controls outside ${obs.coverage.unsupported_frames} frame(s); frame content is not extracted`);
            throw new Stop('NEEDS_REVIEW', decision.reason_codes.some((r) => /budget|deadline/.test(r)) ? 'budget_exhausted' : 'autonomy_abstained', `${m.id}: controller abstained (${decision.reason_codes.join(', ')})`);
          case 'REOBSERVE':
            reobservations++;
            await page.waitForTimeout(300);
            continue;
          case 'ACT':
            break;
        }

        reobservations = 0;
        if (decision.op === 'DONE') {
          const failed = await session.verify(m);
          if (failed.length > 0) {
            throw new Stop('NEEDS_REVIEW', 'assertion_failed', `${m.id}: explorer reported the milestone complete but ${failed.length} of ${m.assertions.length} approved assertion(s) failed — a product defect or a premature DONE; reproduce with the regression contract`);
          }
          break;
        }

        if (decision.op === 'SCROLL') {
          // Effect-free, authorized as such by the gate; counted against the action budget and loop detection.
          actions++;
          await page.mouse.wheel(0, Math.round(obs.viewport.height * 0.8));
          await page.waitForTimeout(150);
          const afterScroll = await observe(page, { pageId: session.attemptId });
          const moved = fingerprint(afterScroll) !== fingerprint(obs);
          noEffect = moved ? 0 : noEffect + 1;
          recent.push({ operation: 'SCROLL', target_name: '', result: moved ? 'effect_observed' : 'no_effect' });
          log.record('decision', `scroll ${moved ? 'revealed new state' : 'had no observable effect'}`, {});
          continue;
        }

        // Execute exactly once on the fresh, gated node.
        actions++;
        const target = byNode.get(decision.node_id!)!;
        const intentId = `${session.attemptId}.i${actions}`;
        let selectOption: string | null = null;
        if (decision.op === 'SELECT') {
          selectOption = await chooseOption(x, session, config, target, goal, m.id);
          decision = { ...decision, parameter_ref: selectOption };
        }
        const auth = authorizeCandidate(decision.op!, decision.node_id, decision.op === 'TYPE' || decision.op === 'SELECT' ? decision.parameter_ref : undefined);
        if (!auth.allowed) throw new Stop('BLOCKED', 'policy_denied', `${m.id}: ${decision.op} "${target.name}" refused at dispatch: ${auth.reason}`);
        const r = await resolveNode(page, obs.document_id, decision.node_id!);
        if (!r.ok) {
          log.record('intent', `not dispatched: node ${r.reason}`, { intent_id: intentId, state: 'failed' });
          continue;
        }
        const h: ElementHandle<Element> = r.handle;
        try {
          if (decision.op === 'CLICK') await h.click({ trial: true, timeout: session.remainingMs(s.budgets.action_timeout_ms) });
        } catch (e) {
          await h.dispose().catch(() => undefined);
          log.record('intent', `not dispatched: ${(e as Error).message.split('\n')[0]}`, { intent_id: intentId, state: 'failed' });
          recent.push({ operation: decision.op!, target_name: target.name, result: 'failed' });
          noEffect++;
          continue;
        }
        const outcome = await session.dispatch(
          {
            intent_id: intentId,
            operation: decision.op!,
            description: `${decision.op} ${target.role} "${target.name}"`,
            route: obs.route,
            control: { role: target.role, name: target.name, form: target.form, section: target.section },
            observation_id: obs.observation_id,
            target: decision.node_id,
            target_role: target.role,
            target_name: target.name,
            milestone_id: m.id,
            parameter_ref: decision.parameter_ref,
            action_intent: auth.intent,
            contract_intent: auth.intent,
            effect: auth.effect,
            risk_class: auth.risk_class,
            mutation: auth.mutation,
          },
          async () => {
            try {
              if (decision.op === 'CLICK') {
                await h.click({ timeout: session.remainingMs(s.budgets.action_timeout_ms) });
                await page.waitForLoadState('load', { timeout: session.remainingMs(s.budgets.action_timeout_ms) });
                await page.waitForLoadState('networkidle', { timeout: session.remainingMs(5_000) }).catch(() => undefined);
              } else if (decision.op === 'SELECT') {
                await h.selectOption({ label: selectOption! }, { timeout: session.remainingMs(s.budgets.action_timeout_ms) });
              } else {
                await h.fill(session.resolveValue(decision.parameter_ref!), { timeout: session.remainingMs(s.budgets.action_timeout_ms) });
              }
              return { status: 'done', detail: `${decision.op} "${target.name}"` };
            } catch (e) {
              return { status: 'effect_unknown', reason: 'step_failed', detail: (e as Error).message.split('\n')[0]! };
            } finally {
              await h.dispose().catch(() => undefined);
            }
          },
        );
        if (outcome.status === 'effect_unknown') throw new Stop('ERROR', 'step_failed', `${m.id}: ${decision.op} "${target.name}" may have been dispatched; effect unknown and not retried`);
        session.checkpoint();
        const after = await observe(page, { pageId: session.attemptId });
        const effect = fingerprint(after) !== fingerprint(obs);
        noEffect = effect ? 0 : noEffect + 1;
        recent.push({ operation: decision.op!, target_name: target.name, result: effect ? 'effect_observed' : 'no_effect' });
        log.record('intent', `${effect ? 'effect observed' : 'no observable effect'}: ${decision.op} "${target.name}"`, { intent_id: intentId, state: effect ? 'effect_observed' : 'no_effect' });
        const fp = stateKey(after);
        const seen = (visits.get(fp) ?? 0) + 1;
        visits.set(fp, seen);
        if (seen >= MAX_STATE_VISITS) throw new Stop('NEEDS_REVIEW', 'autonomy_abstained', `${m.id}: loop detected — the same page state was reached ${seen} times`);
      }
    }
  };
}
