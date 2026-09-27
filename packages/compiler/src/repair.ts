import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { CaseResult, Locator, Observation, ObservedElement, Scenario } from '@qa/contracts';

export interface RepairPatch {
  path: string;
  from: unknown;
  to: unknown;
}

export interface RepairProposal {
  kind: 'locator' | 'wait';
  scenario_id: string;
  from_sha256: string;
  patch: RepairPatch[];
  evidence: string[];
  confidence: number;
}

export const scenarioHash = (s: Scenario) => createHash('sha256').update(stringify(s)).digest('hex');

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Token-set similarity: robust to added words ("Place order" → "Place your order"). */
export function nameSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((t) => y.has(t)).length;
  return (2 * inter) / (x.size + y.size);
}

/**
 * Propose a locator repair from failure evidence: the failing step's address
 * (from the intent log) and the page observation captured at failure. Only a
 * unique, similar candidate with the same role yields a proposal; anything
 * else is left for a human, because it may be a real regression.
 */
export async function proposeLocatorRepair(o: { runDir: string; result: CaseResult; scenario: Scenario; minSimilarity?: number }): Promise<RepairProposal | { none: string }> {
  if (o.result.verdict !== 'FAIL' || o.result.reason !== 'step_target_unavailable') return { none: 'only step_target_unavailable failures are locator-repair candidates' };
  const ev = o.result.artifacts.find((a) => a.kind === 'events');
  const dom = o.result.artifacts.find((a) => a.kind === 'dom');
  if (!ev || !dom) return { none: 'failure evidence lacks an event log or a DOM observation' };
  const events = (await readFile(join(o.runDir, ev.path), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
  const failed = [...events].reverse().find((e) => e.kind === 'intent' && e.data.state === 'failed');
  const persisted = failed && events.find((e) => e.kind === 'intent' && e.data.state === 'persisted' && e.data.intent_id === failed.data.intent_id);
  if (!persisted) return { none: 'no failed step in the intent log' };
  const mi = o.scenario.milestones.findIndex((m) => m.id === persisted.data.milestone_id);
  const si = Number(persisted.data.step_index);
  const step = o.scenario.milestones[mi]?.steps[si];
  if (!step || !('target' in step)) return { none: 'failed step has no target' };
  const target: Locator = step.target;
  if (!('role' in target) && !('label' in target)) return { none: 'test-id locators are contract identifiers; a missing test id is not repaired automatically' };
  const obs = JSON.parse(await readFile(join(o.runDir, dom.path), 'utf8')) as Observation;
  const role = 'role' in target ? target.role : 'textbox';
  const wanted = 'role' in target ? target.name : target.label;
  const op = step.op === 'click' ? 'CLICK' : step.op === 'type' ? 'TYPE' : 'SELECT';
  const pool: ObservedElement[] = [...obs.candidates, ...obs.diagnostics].filter((c) => c.role === role && c.name && c.name !== wanted);
  const scored = pool.map((c) => ({ c, score: nameSimilarity(wanted, c.name) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const min = o.minSimilarity ?? 0.6;
  if (!best || best.score < min) return { none: `no ${role} resembling "${wanted}" was observed` };
  if (scored[1] && scored[1].score >= best.score - 0.1) return { none: `ambiguous: "${best.c.name}" and "${scored[1].c.name}" are equally plausible` };
  if (!best.c.supported_operations.includes(op)) return { none: `"${best.c.name}" is present but not actionable (${best.c.enabled ? 'hidden' : 'disabled'}); this may be a real defect` };
  const to: Locator = 'role' in target ? { role, name: best.c.name } : { label: best.c.name };
  return {
    kind: 'locator',
    scenario_id: o.scenario.id,
    from_sha256: scenarioHash(o.scenario),
    patch: [{ path: `milestones.${mi}.steps.${si}.target`, from: target, to }],
    evidence: [`${o.result.attempt_id}: ${o.result.message ?? ''}`, `observed ${role} "${best.c.name}" (similarity ${best.score.toFixed(2)})`],
    confidence: best.score,
  };
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function applyRepair(s: Scenario, p: RepairProposal): Scenario {
  if (scenarioHash(s) !== p.from_sha256) throw new Error('scenario changed since the repair was proposed');
  const copy = structuredClone(s);
  for (const x of p.patch) {
    const keys = x.path.split('.');
    const parent = get(copy, keys.slice(0, -1).join('.')) as Record<string, unknown>;
    if (JSON.stringify(parent[keys.at(-1)!]) !== JSON.stringify(x.from)) throw new Error(`patch precondition failed at ${x.path}`);
    parent[keys.at(-1)!] = x.to;
  }
  return copy;
}

/** Leaf-level structural diff of two scenarios. */
export function diffScenarios(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return [`${path}.length`];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diffScenarios((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return [path];
}

export interface RepairValidation {
  ok: boolean;
  classification: 'locator' | 'wait' | 'semantic_requirement_change';
  violations: string[];
}

/**
 * A repair may change *how* an element is found or how long to wait — never
 * *what* is verified. Deleting or editing assertions, touching requirements,
 * policy, fixtures, cleanup or visual tolerances is a semantic requirement
 * change that needs its own reviewed approval.
 */
export function validateRepair(original: Scenario, repaired: Scenario): RepairValidation {
  const changed = diffScenarios(original, repaired);
  const violations: string[] = [];
  let locator = false;
  let wait = false;
  for (const p of changed) {
    if (/^milestones\.\d+\.steps\.\d+\.target(\.|$)/.test(p)) locator = true;
    else if (/^budgets\.(action_timeout_ms|assertion_timeout_ms)$/.test(p)) {
      const key = p.split('.')[1] as 'action_timeout_ms' | 'assertion_timeout_ms';
      const before = original.budgets[key];
      const after = repaired.budgets[key];
      if (after < before) violations.push(`${p}: timeouts may only increase in a wait repair`);
      else if (after > before * 3) violations.push(`${p}: increase beyond 3× needs review as a performance change`);
      else wait = true;
    } else if (/^milestones\.\d+\.assertions/.test(p) || p.endsWith('assertions.length')) violations.push(`${p}: assertions cannot be deleted, added or loosened by a repair`);
    else if (/^milestones(\.length|\.\d+\.steps\.length)$/.test(p)) violations.push(`${p}: steps or milestones cannot be added or removed by a repair`);
    else violations.push(`${p}: not a locator or wait change`);
  }
  if (changed.length === 0) violations.push('repair changes nothing');
  const classification = violations.length ? 'semantic_requirement_change' : locator ? 'locator' : wait ? 'wait' : 'semantic_requirement_change';
  return { ok: violations.length === 0, classification, violations };
}
