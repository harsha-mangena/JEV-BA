import type { ExecutionProfileId, Scenario, SelectionManifest } from '@qa/contracts';
import type { Comparison } from './diff.ts';
import { allRoutes, matchesAny, requirementsOfRoute, type CoverageGraph } from './graph.ts';

/** Observed scenario → route edges learned from run evidence. */
export type RouteUsage = Record<string, string[]>;

export interface SelectInput {
  graph: CoverageGraph;
  scenarios: Scenario[];
  environment: string;
  profiles?: ExecutionProfileId[];
  suite_revision: string;
  candidate_sha: string;
  comparison: Comparison;
  usage?: RouteUsage;
}

/**
 * Selection = mandatory smoke ∪ impact closure ∪ risk-triggered suites ∪
 * bounded exploration. Anything uncertain broadens: a missing comparison, a
 * non-ancestor history, an unmapped path, a rename that loses traceability,
 * or a broadening trigger all select the full suite. Every selected case and
 * every omission carries its reason.
 */
export function selectImpacted(i: SelectInput): SelectionManifest {
  const { graph } = i;
  const explanation: string[] = [];
  const gaps: SelectionManifest['gaps'] = [];
  let full: string | null = null;
  const impactedRequirements = new Map<string, string[]>();
  const impactedRoutes = new Map<string, string[]>();
  const note = (m: Map<string, string[]>, k: string, why: string) => m.set(k, [...new Set([...(m.get(k) ?? []), why])]);

  if (i.comparison.kind !== 'ok') {
    full = `comparison ${i.comparison.kind}: ${i.comparison.detail}`;
    gaps.push({ kind: 'missing_comparison', subject: i.comparison.base ?? 'none', detail: i.comparison.detail });
  } else {
    explanation.push(`${i.comparison.files.length} changed file(s) between ${i.comparison.base.slice(0, 12)} and ${i.comparison.head.slice(0, 12)}`);
    for (const f of i.comparison.files) {
      const paths = [f.path, ...(f.previous_path ? [f.previous_path] : [])];
      const trigger = graph.broadening_triggers.find((t) => paths.some((p) => matchesAny(p, t.paths)));
      if (trigger) {
        full ??= `broadening trigger: ${trigger.reason} (${f.path})`;
        explanation.push(`${f.path}: ${trigger.reason} → full suite`);
        continue;
      }
      if (paths.every((p) => matchesAny(p, graph.ignore))) {
        explanation.push(`${f.path}: declared as non-behavioural (ignored)`);
        continue;
      }
      const comps = graph.components.filter((c) => paths.some((p) => matchesAny(p, c.paths)));
      if (f.previous_path && comps.length > 0 && !graph.components.some((c) => matchesAny(f.path, c.paths))) {
        gaps.push({ kind: 'renamed_path', subject: `${f.previous_path} → ${f.path}`, detail: 'new path is not mapped; traceability would be lost' });
        full ??= `renamed path lost traceability: ${f.path}`;
      }
      if (comps.length === 0) {
        gaps.push({ kind: 'unmapped_path', subject: f.path, detail: 'no component claims this path' });
        full ??= `unknown impact: ${f.path} is not mapped to any component`;
        continue;
      }
      for (const c of comps) {
        for (const r of c.routes) note(impactedRoutes, r, `${f.path} → ${c.id}`);
        for (const cap of c.capabilities) for (const req of graph.capabilities[cap] ?? []) note(impactedRequirements, req, `${f.path} → ${c.id} → ${cap}`);
        for (const r of c.routes) for (const req of requirementsOfRoute(graph, r)) note(impactedRequirements, req, `${f.path} → ${c.id} → ${r}`);
      }
    }
  }
  if (full) explanation.push(`full suite: ${full}`);

  const known = new Set(Object.values(graph.capabilities).flat());
  const covered = new Set(i.scenarios.filter((s) => s.mode === 'regression').flatMap((s) => s.requirement_ids));
  for (const req of known) if (!covered.has(req)) gaps.push({ kind: 'requirement_without_scenario', subject: req, detail: 'no approved regression scenario covers this requirement' });

  const manifest: SelectionManifest = {
    version: 1,
    suite_revision: i.suite_revision,
    strategy: full ? 'full' : 'impact',
    base_sha: i.comparison.base,
    candidate_sha: i.candidate_sha,
    cases: [],
    omitted: [],
    exploration: [],
    gaps,
    explanation,
  };
  const profileOk = (p: ExecutionProfileId) => !i.profiles || i.profiles.includes(p);
  const routes = allRoutes(graph);
  let explorationLeft = graph.exploration_budget.max_scenarios;

  for (const s of i.scenarios) {
    if (!s.policy.environments.includes(i.environment)) {
      manifest.omitted.push({ scenario_id: s.id, reason: `not permitted in environment ${i.environment}` });
      continue;
    }
    const reasons: string[] = [];
    if (full) reasons.push(full.startsWith('broadening') ? 'risk_triggered' : full.startsWith('unknown') || full.startsWith('renamed') ? 'unknown_impact' : 'full_suite');
    if (s.critical) reasons.push('mandatory_smoke');
    for (const req of s.requirement_ids) if (impactedRequirements.has(req)) reasons.push(`impacted: ${req} via ${impactedRequirements.get(req)!.join('; ')}`);
    const visited = new Set([...(i.usage?.[s.id] ?? []), s.start_path]);
    for (const r of visited) {
      const route = routes.find((x) => x === r) ?? r;
      if (impactedRoutes.has(route)) reasons.push(`impacted route ${route} (observed usage) via ${impactedRoutes.get(route)!.join('; ')}`);
    }
    if (reasons.length === 0) {
      manifest.omitted.push({ scenario_id: s.id, reason: 'no impacted requirement or route; not a mandatory smoke journey' });
      continue;
    }
    for (const p of s.execution_profiles.filter(profileOk)) {
      if (s.mode === 'regression') manifest.cases.push({ scenario_id: s.id, execution_profile: p, required: true, reasons });
      else if (explorationLeft > 0) manifest.exploration.push({ scenario_id: s.id, execution_profile: p, reasons: [...reasons, 'bounded exploration (advisory)'] });
    }
    if (s.mode === 'exploration') {
      if (explorationLeft > 0) explorationLeft--;
      else manifest.omitted.push({ scenario_id: s.id, reason: 'exploration budget exhausted' });
    }
  }
  return manifest;
}
