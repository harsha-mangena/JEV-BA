import { z } from 'zod';
import { Locator, RequirementId, loadYaml } from '@qa/contracts';

const Glob = z.string().min(1);

export const EdgeProvenance = z.enum(['declared', 'static', 'observed', 'suggested']);
export type EdgeProvenance = z.infer<typeof EdgeProvenance>;

const InputClass = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    value: z.string().optional(),
    value_repeat: z.object({ char: z.string().length(1), count: z.number().int().min(0).max(10_000) }).strict().optional(),
    expect: z.enum(['reject', 'accept']),
    error_testid: z.string().optional(),
    error_text: z.string().optional(),
    success_testid: z.string().optional(),
  })
  .strict()
  .refine((c) => (c.value === undefined) !== (c.value_repeat === undefined), 'exactly one of value or value_repeat')
  .refine((c) => (c.expect === 'reject' ? !!c.error_testid && c.error_text !== undefined : !!c.success_testid), 'reject classes need error_testid and error_text; accept classes need success_testid');

/**
 * Requirement graph: source paths → components → routes → capabilities →
 * requirements, plus broadening triggers, declared transitions and input
 * equivalence classes. Declared edges come from this file; observed edges
 * are learned from run evidence; suggested edges (S2) are advisory only.
 */
export const CoverageGraph = z
  .object({
    schema_version: z.literal(1),
    components: z.array(z.object({ id: z.string(), paths: z.array(Glob).min(1), routes: z.array(z.string().startsWith('/')).default([]), capabilities: z.array(z.string()).default([]) }).strict()),
    routes: z.record(z.string().startsWith('/'), z.array(z.string())).default({}),
    capabilities: z.record(z.string(), z.array(RequirementId)),
    broadening_triggers: z.array(z.object({ paths: z.array(Glob).min(1), reason: z.string() }).strict()).default([]),
    /** Paths that cannot affect runtime behaviour. Must be declared explicitly; nothing is ignored by default. */
    ignore: z.array(Glob).default([]),
    transitions: z.array(z.tuple([z.string().startsWith('/'), z.string().startsWith('/')])).default([]),
    exploration_budget: z.object({ max_scenarios: z.number().int().nonnegative().default(1) }).strict().default({}),
    input_classes: z
      .record(
        z.string().regex(/^[a-z0-9_]+$/),
        z
          .object({
            requirement: RequirementId,
            start_path: z.string().startsWith('/'),
            fixture: z.string(),
            role: z.string(),
            field: Locator,
            submit: Locator,
            intent: z.string().optional(),
            mutation: z.string().optional(),
            entity: z.enum(['order', 'note']),
            owner_ref: z.string(),
            classes: z.array(InputClass).min(1),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type CoverageGraph = z.output<typeof CoverageGraph>;

export const loadCoverageGraph = (path: string) => loadYaml(CoverageGraph, path);

/** Glob matching: `**` spans directories, `*` stays within a segment. */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path: string, globs: readonly string[]) => globs.some((g) => globToRegex(g).test(path));

/** Normalize a concrete path to a declared route pattern (`/orders/ord_1` → `/orders/:id`). */
export function normalizeRoute(path: string, patterns: readonly string[]): string {
  for (const p of patterns) {
    const re = new RegExp(`^${p.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
    if (re.test(path)) return p;
  }
  return path;
}

export function allRoutes(g: CoverageGraph): string[] {
  return [...new Set([...Object.keys(g.routes), ...g.components.flatMap((c) => c.routes), ...g.transitions.flat()])];
}

export function requirementsOfRoute(g: CoverageGraph, route: string): string[] {
  return [...new Set((g.routes[route] ?? []).flatMap((cap) => g.capabilities[cap] ?? []))];
}
