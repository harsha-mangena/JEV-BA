import { z } from 'zod';
import { Scenario, parseWith, validateScenarioSemantics, type FixtureCatalog, type ProjectPolicy, type ScenarioInput } from '@qa/contracts';
import type { CoverageGraph } from './graph.ts';

/** Where an assertion's expected value comes from. `observed` means "copied from the current app" and is never an oracle. */
export const OracleProvenance = z.object({
  kind: z.enum(['fixture', 'requirement', 'equivalence_class', 'observed']),
  ref: z.string().min(1),
});

export const ScenarioProposal = z
  .object({
    source: z.enum(['s2', 'equivalence_class', 'compiler', 'repair']),
    rationale: z.string().max(2000),
    scenario: z.unknown(),
    /** One entry per assertion, keyed `<milestone_id>#<index>`. */
    oracles: z.record(z.string(), OracleProvenance),
  })
  .strict();
export type ScenarioProposal = z.infer<typeof ScenarioProposal>;

export type ProposalValidation = { ok: true; scenario: Scenario; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Validate a proposed test. A proposal can never bless current behaviour: every
 * assertion needs an oracle from a fixture, a requirement or a declared
 * equivalence class, and every requirement must exist in the graph. Valid
 * proposals are still only *proposed* — they gate nothing until approved.
 */
export function validateProposal(raw: unknown, ctx: { graph: CoverageGraph; catalog: FixtureCatalog; policy: ProjectPolicy }): ProposalValidation {
  const p = ScenarioProposal.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  let scenario: Scenario;
  try {
    scenario = parseWith(Scenario, p.data.scenario, 'proposal');
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const errors = validateScenarioSemantics(scenario, ctx.catalog, ctx.policy).map((i) => `${i.path}: ${i.message}`);
  const known = new Set(Object.values(ctx.graph.capabilities).flat());
  for (const r of scenario.requirement_ids) if (!known.has(r)) errors.push(`requirement ${r} is not in the requirement graph`);
  const warnings: string[] = [];
  for (const m of scenario.milestones) {
    m.assertions.forEach((a, i) => {
      const key = `${m.id}#${i}`;
      const o = p.data.oracles[key];
      if (!o) return errors.push(`${key}: missing oracle provenance`);
      if (o.kind === 'observed') return errors.push(`${key}: expected value was observed from the current application; that would bless current behaviour`);
      if (o.kind === 'requirement' && !scenario.requirement_ids.includes(o.ref)) errors.push(`${key}: oracle cites requirement ${o.ref} which the scenario does not declare`);
      const usesFixture = JSON.stringify(a).includes('"fixture.');
      if (o.kind === 'fixture' && !usesFixture) errors.push(`${key}: oracle claims a fixture source but the assertion has no fixture reference`);
    });
  }
  const extra = Object.keys(p.data.oracles).filter((k) => !scenario.milestones.some((m) => m.assertions.some((_, i) => `${m.id}#${i}` === k)));
  if (extra.length) warnings.push(`oracle entries for unknown assertions: ${extra.join(', ')}`);
  return errors.length ? { ok: false, errors } : { ok: true, scenario, warnings };
}

/**
 * Generate boundary and negative scenario proposals from declared input
 * equivalence classes. Expected outcomes come from the class declarations,
 * never from running the application.
 */
export function proposalsFromEquivalenceClasses(graph: CoverageGraph): ScenarioProposal[] {
  const out: ScenarioProposal[] = [];
  for (const [field, spec] of Object.entries(graph.input_classes)) {
    for (const c of spec.classes) {
      const value = c.value ?? c.value_repeat!.char.repeat(c.value_repeat!.count);
      const outcome =
        c.expect === 'reject'
          ? [
              { type: 'ui_text', target: c.error_testid!, equals: c.error_text! },
              { type: 'entity_count_delta', entity: spec.entity, owner_ref: spec.owner_ref, equals: 0 },
            ]
          : [
              { type: 'ui_visible', target: c.success_testid! },
              { type: 'entity_count_delta', entity: spec.entity, owner_ref: spec.owner_ref, equals: 1 },
            ];
      const scenario: ScenarioInput = {
        schema_version: 1,
        id: `${field}_${c.id}`,
        requirement_ids: [spec.requirement],
        mode: 'regression',
        start_path: spec.start_path,
        fixture: spec.fixture,
        role: spec.role,
        goal: `Equivalence class ${field}/${c.id}: input is ${c.expect}ed.`,
        milestones: [
          {
            id: `${c.expect}ed`,
            steps: [
              { op: 'type', target: spec.field, value },
              { op: 'click', target: spec.submit, ...(spec.intent ? { intent: spec.intent } : {}) },
            ],
            assertions: outcome as never,
          },
        ],
        execution_profiles: ['chromium_desktop'],
        policy: { environments: ['local', 'preview', 'staging'], mutations: spec.mutation ? [spec.mutation] : [], external_effects: 'sandbox_only', allowed_origin_profile: 'owned_app' },
        cleanup: 'delete_test_owned_entities',
      };
      out.push({
        source: 'equivalence_class',
        rationale: `${c.expect === 'reject' ? 'Negative' : 'Boundary'} case for ${field}: class ${c.id}.`,
        scenario,
        oracles: Object.fromEntries(outcome.map((_, i) => [`${c.expect}ed#${i}`, { kind: 'equivalence_class' as const, ref: `${field}/${c.id}` }])),
      });
    }
  }
  return out;
}

/** System Two test-proposal adapter; output is validated with {@link validateProposal} and never auto-approved. */
export interface TestProposer {
  propose(input: { changed_files: string[]; impacted_requirements: string[]; graph_summary: string }): Promise<unknown[]>;
}
