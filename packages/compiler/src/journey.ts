import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Scenario, parseWith, validateScenarioSemantics, type CaseResult, type FixtureCatalog, type ProjectPolicy, type ScenarioInput, type Step } from '@qa/contracts';

interface IntentEvent {
  kind: string;
  summary: string;
  data: { intent_id?: string; operation?: string; target_role?: string; target_name?: string; parameter_ref?: string | null; action_intent?: string | null; milestone_id?: string; state?: string };
}

export type CompileResult = { ok: true; scenario: Scenario; oracles: Record<string, { kind: 'requirement'; ref: string }> } | { ok: false; errors: string[] };

/**
 * Promote a successful exploration journey into a deterministic regression
 * scenario. Steps come from the actions the controller actually dispatched
 * (stable role + accessible-name locators); assertions are copied verbatim
 * from the approved source contract, so the compiled test checks exactly
 * what the exploration was verified against — nothing is inferred from the
 * page.
 */
export async function compileJourney(o: { runDir: string; result: CaseResult; source: Scenario; catalog: FixtureCatalog; policy: ProjectPolicy }): Promise<CompileResult> {
  const errors: string[] = [];
  if (o.source.mode !== 'exploration') errors.push('only exploration journeys are compiled');
  if (o.result.verdict !== 'PASS') errors.push(`journey verdict is ${o.result.verdict}; only fully verified journeys are compiled`);
  const ev = o.result.artifacts.find((a) => a.kind === 'events');
  if (!ev) errors.push('run evidence has no event log');
  if (errors.length) return { ok: false, errors };

  const events = (await readFile(join(o.runDir, ev!.path), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as IntentEvent);
  const persisted = new Map<string, IntentEvent>();
  const dispatched: IntentEvent[] = [];
  for (const e of events) {
    if (e.kind !== 'intent' || !e.data.intent_id) continue;
    if (e.data.state === 'persisted') persisted.set(e.data.intent_id, e);
    else if (e.data.state === 'effect_observed' || e.data.state === 'no_effect') {
      const p = persisted.get(e.data.intent_id);
      if (p) dispatched.push(p);
    }
  }
  const steps = new Map<string, Step[]>();
  for (const e of dispatched) {
    const d = e.data;
    if (!d.target_role || !d.target_name || !d.milestone_id) {
      errors.push(`intent ${d.intent_id} lacks a stable role/name locator`);
      continue;
    }
    const target = { role: d.target_role, name: d.target_name };
    const step: Step =
      d.operation === 'TYPE'
        ? { op: 'type', target, value_ref: d.parameter_ref! }
        : d.operation === 'CLICK'
          ? ({ op: 'click', target, ...(d.action_intent ? { intent: d.action_intent } : {}) } as Step)
          : (errors.push(`operation ${d.operation} is not compilable`) as never);
    steps.set(d.milestone_id, [...(steps.get(d.milestone_id) ?? []), step]);
  }
  if (errors.length) return { ok: false, errors };

  const { inputs: _inputs, ...rest } = o.source;
  const input: ScenarioInput = {
    ...rest,
    id: `${o.source.id}_compiled`,
    mode: 'regression',
    critical: false,
    goal: `${o.source.goal} (compiled from verified exploration ${o.result.attempt_id})`,
    execution_profiles: [o.result.execution_profile as 'chromium_desktop'],
    milestones: o.source.milestones.map((m) => ({ ...m, steps: steps.get(m.id) ?? [] })),
  };
  const scenario = parseWith(Scenario, input, 'compiled journey');
  const issues = validateScenarioSemantics(scenario, o.catalog, o.policy);
  if (issues.length) return { ok: false, errors: issues.map((i) => `${i.path}: ${i.message}`) };
  const oracles = Object.fromEntries(scenario.milestones.flatMap((m) => m.assertions.map((_, i) => [`${m.id}#${i}`, { kind: 'requirement' as const, ref: scenario.requirement_ids[0]! }])));
  return { ok: true, scenario, oracles };
}
