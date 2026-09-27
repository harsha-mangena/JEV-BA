import { z } from 'zod';
import { RequirementId, Slug, ValueRef } from './common.ts';

/**
 * Element locator used by approved deterministic steps and UI assertions.
 * A bare string is shorthand for a `data-testid`. Arbitrary CSS/XPath is
 * deliberately not supported: approved tests use stable roles, labels and ids.
 */
export const Locator = z.union([
  z.string().min(1).transform((testid) => ({ testid })),
  z.object({ testid: z.string().min(1) }).strict(),
  z.object({ role: z.string().min(1), name: z.string().min(1), exact: z.boolean().optional() }).strict(),
  z.object({ label: z.string().min(1) }).strict(),
]);
export type Locator = z.output<typeof Locator>;

export function describeLocator(l: Locator): string {
  if ('testid' in l) return `testid=${l.testid}`;
  if ('role' in l) return `role=${l.role}[name=${JSON.stringify(l.name)}]`;
  return `label=${JSON.stringify(l.label)}`;
}

function exactlyOne(ctx: z.RefinementCtx, obj: object, keys: string[]): void {
  const present = keys.filter((k) => (obj as Record<string, unknown>)[k] !== undefined);
  if (present.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `exactly one of ${keys.join(', ')} is required` });
}

const stepBase = { intent: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/).optional() };

export const Step = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), path: z.string().startsWith('/'), ...stepBase }).strict(),
  z.object({ op: z.literal('click'), target: Locator, ...stepBase }).strict(),
  z.object({ op: z.literal('type'), target: Locator, value: z.string().optional(), value_ref: ValueRef.optional(), ...stepBase }).strict(),
  z.object({ op: z.literal('select'), target: Locator, option: z.string().optional(), option_ref: ValueRef.optional(), ...stepBase }).strict(),
  z.object({ op: z.literal('reload'), ...stepBase }).strict(),
]).superRefine((s, ctx) => {
  if (s.op === 'type') exactlyOne(ctx, s, ['value', 'value_ref']);
  if (s.op === 'select') exactlyOne(ctx, s, ['option', 'option_ref']);
});
export type Step = z.output<typeof Step>;

const integer = z.number().int();

export const Assertion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ui_visible'), target: Locator }).strict(),
  z.object({ type: z.literal('ui_hidden'), target: Locator }).strict(),
  z.object({ type: z.literal('ui_text'), target: Locator, equals: z.string().optional(), equals_ref: ValueRef.optional(), contains: z.string().optional() }).strict(),
  z.object({ type: z.literal('url_path'), equals: z.string().startsWith('/') }).strict(),
  z.object({ type: z.literal('order_count_delta'), customer_ref: ValueRef, equals: integer }).strict(),
  z.object({ type: z.literal('order_total_minor_units'), customer_ref: ValueRef.optional(), equals: integer.optional(), equals_ref: ValueRef.optional() }).strict(),
  z.object({ type: z.literal('entity_count_delta'), entity: z.enum(['order', 'note']), owner_ref: ValueRef, equals: integer }).strict(),
  z.object({ type: z.literal('persists_after_reload'), target: Locator }).strict(),
  z.object({ type: z.literal('no_console_errors') }).strict(),
]).superRefine((a, ctx) => {
  if (a.type === 'ui_text') exactlyOne(ctx, a, ['equals', 'equals_ref', 'contains']);
  if (a.type === 'order_total_minor_units') exactlyOne(ctx, a, ['equals', 'equals_ref']);
});
export type Assertion = z.output<typeof Assertion>;
export type AssertionType = Assertion['type'];

/** Assertions that read application state through the fixture/backend API rather than the UI. */
export const BACKEND_ASSERTIONS: ReadonlySet<AssertionType> = new Set(['order_count_delta', 'order_total_minor_units', 'entity_count_delta']);

export const Milestone = z
  .object({
    id: Slug,
    action_intent: z.string().optional(),
    steps: z.array(Step).default([]),
    assertions: z.array(Assertion).min(1, 'a milestone must have at least one assertion'),
  })
  .strict();
export type Milestone = z.output<typeof Milestone>;

export const ExecutionProfileId = z.enum(['chromium_desktop', 'chromium_mobile_viewport']);
export type ExecutionProfileId = z.infer<typeof ExecutionProfileId>;

export const ScenarioPolicy = z
  .object({
    environments: z.array(z.string().min(1)).min(1),
    mutations: z.array(Slug).default([]),
    external_effects: z.enum(['none', 'sandbox_only']),
    allowed_origin_profile: Slug,
    /** Autonomous exploration only: whether controls with no trusted binding may be clicked as read-only. */
    unknown_actions: z.enum(['deny', 'read_only_exploration']).default('deny'),
  })
  .strict();
export type ScenarioPolicy = z.output<typeof ScenarioPolicy>;

/** Proposed configurable defaults (plan §5.2); not validated performance commitments. */
export const Budgets = z
  .object({
    max_actions: z.number().int().positive().default(40),
    max_reobservations_per_decision: z.number().int().nonnegative().default(2),
    max_s2_calls: z.number().int().nonnegative().default(3),
    max_wall_clock_seconds: z.number().positive().default(120),
    action_timeout_ms: z.number().int().positive().default(5_000),
    assertion_timeout_ms: z.number().int().positive().default(5_000),
  })
  .strict();
export type Budgets = z.output<typeof Budgets>;

export const Scenario = z
  .object({
    schema_version: z.literal(1),
    id: Slug,
    requirement_ids: z.array(RequirementId).min(1),
    mode: z.enum(['regression', 'exploration']),
    critical: z.boolean().default(false),
    start_path: z.string().startsWith('/'),
    fixture: Slug,
    role: z.string().min(1),
    goal: z.string().min(1),
    milestones: z.array(Milestone).min(1, 'a scenario must have at least one milestone'),
    /** Exploration only: fixture values the explorer may type. Secrets are referenced, never inlined. */
    inputs: z.array(ValueRef).default([]),
    execution_profiles: z.array(ExecutionProfileId).min(1),
    policy: ScenarioPolicy,
    budgets: Budgets.default({}),
    cleanup: z.enum(['delete_test_owned_entities', 'none']),
  })
  .strict();
export type Scenario = z.output<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;
