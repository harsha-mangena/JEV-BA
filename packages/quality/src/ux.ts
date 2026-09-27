import type { Observation } from '@qa/contracts';

export interface DecisionSummary {
  route: string;
  outcome: string;
  reason_codes: string[];
}

export interface UxMetrics {
  decisions: number;
  escalations: number;
  /** Escalations per decision, by route. A diagnostic, never a finding on its own. */
  escalation_density_by_route: Record<string, number>;
}

export interface UxHypothesis {
  certainty: 'suspected';
  title: string;
  route: string;
  rubric: string;
  evidence: string[];
}

export function uxMetrics(decisions: DecisionSummary[]): UxMetrics {
  const byRoute = new Map<string, { n: number; e: number }>();
  for (const d of decisions) {
    const r = byRoute.get(d.route) ?? { n: 0, e: 0 };
    r.n++;
    if (d.outcome === 'ESCALATE' || d.reason_codes.some((c) => /uncertain|margin/.test(c))) r.e++;
    byRoute.set(d.route, r);
  }
  return {
    decisions: decisions.length,
    escalations: [...byRoute.values()].reduce((a, r) => a + r.e, 0),
    escalation_density_by_route: Object.fromEntries([...byRoute].map(([k, v]) => [k, v.n ? v.e / v.n : 0])),
  };
}

/**
 * UX hypotheses require structural corroboration in the observed DOM:
 * controls sharing an accessible name within the same section, or unnamed
 * controls. Model uncertainty alone yields a metric, never a hypothesis, and
 * nothing here claims that users are confused.
 */
export function uxHypotheses(observations: Observation[], metrics: UxMetrics, densityThreshold = 0.3): UxHypothesis[] {
  const out: UxHypothesis[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    const density = metrics.escalation_density_by_route[o.route] ?? 0;
    const groups = new Map<string, string[]>();
    for (const c of o.candidates) {
      if (!c.name) {
        const k = `unnamed:${o.route}:${c.role}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ certainty: 'suspected', title: `Potentially unidentifiable ${c.role} (no accessible name)`, route: o.route, rubric: 'Every interactive control has a programmatic name (WCAG 4.1.2).', evidence: [`${c.role} node ${c.node_id} in ${c.section ?? 'page'}`] });
        }
        continue;
      }
      const key = `${c.section ?? ''}\u0000${c.role}\u0000${c.name.toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), c.node_id]);
    }
    for (const [key, nodes] of groups) {
      if (nodes.length < 2 || density < densityThreshold) continue;
      const [section, role, name] = key.split('\u0000');
      const k = `dup:${o.route}:${key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        certainty: 'suspected',
        title: `Potentially unclear choice: ${nodes.length} ${role}s named "${name}"${section ? ` in "${section}"` : ''}`,
        route: o.route,
        rubric: 'Distinct actions within one region have distinguishable names or context.',
        evidence: [`duplicate accessible names: ${nodes.join(', ')}`, `S1 escalation density on ${o.route}: ${density.toFixed(2)}`],
      });
    }
  }
  return out;
}
