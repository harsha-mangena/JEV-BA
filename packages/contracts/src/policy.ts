import { z } from 'zod';
import { Slug } from './common.ts';
import { RiskClass } from './decision.ts';

/**
 * `$candidate` in an origin profile stands for the origin of the verified
 * deployment under test, so profiles never hard-code preview hostnames.
 */
export const CANDIDATE_ORIGIN = '$candidate';

export const ProjectPolicy = z
  .object({
    schema_version: z.literal(1),
    project_id: z.string().min(1),
    environments: z.array(z.string().min(1)).min(1),
    origin_profiles: z.record(Slug, z.object({ origins: z.array(z.string().min(1)).min(1) }).strict()),
    /** Mutation bindings: which action intents a named mutation authorizes, and in which environments. */
    mutations: z.record(
      Slug,
      z
        .object({
          action_intents: z.array(z.string().min(1)).min(1),
          environments: z.array(z.string().min(1)).min(1),
          test_owned_only: z.literal(true),
        })
        .strict(),
    ),
    /**
     * Trusted semantics for observed controls, used by autonomous exploration.
     * The model never decides what a control does; an unbound control has
     * unknown risk and is denied unless the scenario allows read-only exploration.
     */
    control_bindings: z
      .array(
        z
          .object({
            role: z.string().min(1),
            name: z.string().min(1).optional(),
            name_pattern: z.string().min(1).optional(),
            intent: z.string().min(1).optional(),
            risk_class: RiskClass,
          })
          .strict()
          .refine((b) => (b.name === undefined) !== (b.name_pattern === undefined), 'exactly one of name or name_pattern is required')
          .refine((b) => b.risk_class !== 'test_owned_mutation' || b.intent !== undefined, 'a mutation binding requires an intent'),
      )
      .default([]),
  })
  .strict();
export type ProjectPolicy = z.output<typeof ProjectPolicy>;

export function resolveAllowedOrigins(policy: ProjectPolicy, profile: string, candidateOrigin: string): Set<string> {
  const p = policy.origin_profiles[profile];
  if (!p) throw new Error(`unknown origin profile: ${profile}`);
  return new Set(p.origins.map((o) => (o === CANDIDATE_ORIGIN ? candidateOrigin : new URL(o).origin)));
}

export type IntentDecision = { allowed: true; mutation?: string } | { allowed: false; reason: string };

/**
 * Deterministic authorization of a declared action intent. A step with no
 * intent is treated as non-mutating; a step whose intent is bound to a
 * mutation requires that mutation in the scenario policy *and* the current
 * environment in the project binding.
 */
export function authorizeIntent(
  policy: ProjectPolicy,
  scenarioMutations: readonly string[],
  environment: string,
  intent: string | undefined,
): IntentDecision {
  if (!intent) return { allowed: true };
  const bound = Object.entries(policy.mutations).filter(([, m]) => m.action_intents.includes(intent));
  if (bound.length === 0) return { allowed: true };
  for (const [name, m] of bound) {
    if (scenarioMutations.includes(name) && m.environments.includes(environment)) return { allowed: true, mutation: name };
  }
  return {
    allowed: false,
    reason: `intent ${intent} requires one of [${bound.map(([n]) => n).join(', ')}] authorized by the scenario for environment ${environment}`,
  };
}

export interface ControlBinding {
  intent?: string;
  risk_class: z.infer<typeof RiskClass>;
}

/** Resolve the trusted binding for an observed control; first match wins, no match means unknown risk. */
export function bindControl(policy: ProjectPolicy, control: { role: string; name: string }): ControlBinding {
  for (const b of policy.control_bindings) {
    if (b.role !== control.role) continue;
    const hit = b.name !== undefined ? b.name === control.name : new RegExp(`^(?:${b.name_pattern})$`).test(control.name);
    if (hit) return { ...(b.intent ? { intent: b.intent } : {}), risk_class: b.risk_class };
  }
  return { risk_class: 'unknown' };
}
