import { z } from 'zod';
import { Slug } from './common.ts';
import { RiskClass } from './decision.ts';

/**
 * `$candidate` in an origin profile stands for the origin of the verified
 * deployment under test, so profiles never hard-code preview hostnames.
 */
export const CANDIDATE_ORIGIN = '$candidate';

export const ContractOperation = z.enum(['CLICK', 'TYPE', 'SELECT', 'PRESS']);
export type ContractOperation = z.infer<typeof ContractOperation>;

const ControlBindingSpec = z
  .object({
    role: z.string().min(1),
    name: z.string().min(1).optional(),
    name_pattern: z.string().min(1).optional(),
    /** Route path(s) where this binding applies (`:param` segments allowed). Omitted = any route. */
    route: z.union([z.string().startsWith('/'), z.array(z.string().startsWith('/')).min(1)]).optional(),
    /** Accessible name of the enclosing form, if the binding is form-scoped. */
    form: z.string().min(1).optional(),
    /** Accessible name of the enclosing section/dialog, if section-scoped. */
    section: z.string().min(1).optional(),
    section_pattern: z.string().min(1).optional(),
    operations: z.array(ContractOperation).min(1).optional(),
    intent: z.string().min(1).optional(),
    risk_class: RiskClass,
    /** Parameter references this input accepts (`fixture.x`, `secret.x`, or `literal`). Required for TYPE/SELECT bindings. */
    accepts: z.array(z.string().regex(/^(literal|fixture\.[a-z0-9_]+|secret\.[a-z0-9_]+)$/)).optional(),
    /** Fixture roles allowed to use this control. Omitted = any role. */
    roles: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((b) => (b.name === undefined) !== (b.name_pattern === undefined), 'exactly one of name or name_pattern is required')
  .refine((b) => b.risk_class !== 'test_owned_mutation' || b.intent !== undefined, 'a mutation binding requires an intent');
export type ControlBindingSpec = z.output<typeof ControlBindingSpec>;

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
    /** Version of the application contract (intents, routes, bindings); part of the execution identity. */
    contract_version: z.string().min(1).default('unversioned'),
    /**
     * Registry of every action intent the application contract knows. Unknown
     * intents are rejected, never treated as benign. `session` intents change
     * authentication state only; `mutation` intents change business data.
     */
    intents: z.record(z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/), z.object({ kind: z.enum(['benign', 'session', 'mutation', 'external']), description: z.string().optional() }).strict()).default({}),
    /** Navigable routes and their effect. Navigation to an unregistered route is denied. */
    routes: z.array(z.object({ path: z.string().startsWith('/'), effect: z.enum(['none', 'session']).default('none') }).strict()).default([]),
    /**
     * Trusted semantics for controls, scoped by route, form and section. The
     * model never decides what a control does; a control with no binding has
     * unknown effect and is denied for every operation and every driver.
     */
    control_bindings: z.array(ControlBindingSpec).default([]),
    /**
     * Pixel privacy: CSS selectors of regions that can show sensitive data the
     * runner cannot detect as text (e.g. server-rendered images). They are
     * masked in every captured image, in addition to registered secrets and
     * uninspectable content.
     */
    privacy: z.object({ mask_selectors: z.array(z.string().min(1)).default([]) }).strict().default({}),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const [name, m] of Object.entries(p.mutations)) {
      for (const i of m.action_intents) {
        if (p.intents[i] && p.intents[i]!.kind !== 'mutation') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mutations', name], message: `intent ${i} is registered as ${p.intents[i]!.kind}, not mutation` });
      }
    }
    p.control_bindings.forEach((b, i) => {
      if (b.intent && Object.keys(p.intents).length > 0 && !p.intents[b.intent]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['control_bindings', i, 'intent'], message: `intent ${b.intent} is not registered` });
    });
  });
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

/**
 * Legacy role/name lookup kept for reporting. Authorization must use
 * `authorizeAction`, which scopes bindings by route, form, section and operation.
 */
export function bindControl(policy: ProjectPolicy, control: { role: string; name: string }): ControlBinding {
  for (const b of policy.control_bindings) {
    if (b.role !== control.role) continue;
    const hit = b.name !== undefined ? b.name === control.name : new RegExp(`^(?:${b.name_pattern})$`).test(control.name);
    if (hit) return { ...(b.intent ? { intent: b.intent } : {}), risk_class: b.risk_class };
  }
  return { risk_class: 'unknown' };
}
