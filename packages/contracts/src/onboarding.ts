import { z } from 'zod';

/**
 * Target onboarding manifest (completion plan, Phase 4). It lists every input
 * the application owner must supply before JEV-BA can test that application
 * for real. Nothing here is guessed: a field the owner has not supplied is
 * `null`, and `checkOnboarding` reports it as a named missing input (BLOCKED),
 * never as a default. Secrets are referenced by environment-variable name,
 * never stored.
 */
const EnvRef = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must name an environment variable');
const Owned = <T extends z.ZodTypeAny>(t: T) => t.nullable();

export const TargetOnboarding = z
  .object({
    schema_version: z.literal(1),
    application: z.object({ name: z.string().min(1), owner_contact: Owned(z.string().min(1)) }).strict(),
    /** Repository, environment and deployment provider/channel: candidate provenance and lineage. */
    source: Owned(
      z
        .object({
          repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
          provider: z.enum(['github', 'vercel', 'pipeline', 'manual']),
          environment: z.string().min(1),
          channel: z.enum(['single', 'per_channel']),
        })
        .strict(),
    ),
    /** Immutable candidate URL pattern and the endpoint that reports the deployed revision. */
    candidate: Owned(
      z
        .object({
          url_pattern: z.string().regex(/^https?:\/\/[^/\s]+$/),
          revision_endpoint: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('json'), path: z.string().startsWith('/'), field: z.string().min(1) }).strict(),
            z.object({ kind: z.literal('meta'), path: z.string().startsWith('/'), name: z.string().min(1) }).strict(),
          ]),
        })
        .strict(),
    ),
    /** Critical journeys with the owner's approved expectations (never inferred from current behaviour). */
    journeys: Owned(
      z
        .array(
          z
            .object({
              id: z.string().min(1),
              roles: z.array(z.string().min(1)).min(1),
              scenario_file: z.string().min(1),
              expectations_approved_by: z.string().min(1),
            })
            .strict(),
        )
        .min(1),
    ),
    /** Scoped test identities and fixture provisioning. */
    identities: Owned(
      z
        .object({
          fixture_api_url: z.string().url().nullable(),
          fixture_token_env: EnvRef,
          roles: z.array(z.object({ role: z.string().min(1), fixture: z.string().min(1) }).strict()).min(1),
        })
        .strict(),
    ),
    /** Mutation bindings with idempotency keys and effect lookup, for authorization and reconciliation. */
    mutations: Owned(
      z
        .array(
          z
            .object({
              binding: z.string().min(1),
              idempotency_key: z.string().min(1),
              effect_lookup: z.string().min(1),
            })
            .strict(),
        )
        .min(1),
    ),
    /** Backend oracles that verify persisted business outcomes. */
    backend_oracles: Owned(z.array(z.object({ id: z.string().min(1), verifies: z.string().min(1), endpoint_env: EnvRef }).strict()).min(1)),
    /** Cleanup rules and sandboxes for external services. */
    cleanup: Owned(z.object({ rules: z.array(z.string().min(1)).min(1), external_sandboxes: z.array(z.string().min(1)) }).strict()),
    /** Qualification scope: browsers, viewports, locales and visual checkpoints. */
    profiles: Owned(
      z
        .object({
          browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).min(1),
          viewports: z.array(z.string().regex(/^\d+x\d+$/)).min(1),
          locales: z.array(z.string().min(2)).min(1),
          native_devices: z.array(z.string().min(1)),
          visual_checkpoints: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    /** Artifact retention and what may be shared with model providers. */
    artifacts: Owned(z.object({ retention_days: z.number().int().positive(), model_sharing: z.enum(['none', 'text_only', 'sanitized_images']) }).strict()),
    /** The promotion controller that must consume the gate, and how it is reached. */
    promotion: Owned(z.object({ controller: z.string().min(1), access_env: EnvRef, required_check: z.boolean() }).strict()),
  })
  .strict();
export type TargetOnboarding = z.output<typeof TargetOnboarding>;

/** What each owner input is used for (plan Phase 4 table). */
export const ONBOARDING_INPUTS: Record<Exclude<keyof TargetOnboarding, 'schema_version' | 'application'>, string> = {
  source: 'candidate provenance and lineage',
  candidate: 'prove which deployment the browser tested',
  journeys: 'independent pass/fail requirements',
  identities: 'isolated sessions and repeatable state',
  mutations: 'authorize and reconcile actions',
  backend_oracles: 'verify persisted business outcomes',
  cleanup: 'recover disposable data and contain effects',
  profiles: 'define qualification scope',
  artifacts: 'control evidence publication',
  promotion: 'enforce release decisions',
};

export interface OnboardingCheck {
  status: 'READY' | 'BLOCKED' | 'INVALID';
  items: Array<{ input: string; state: 'provided' | 'missing' | 'invalid'; use: string; detail?: string }>;
}

/**
 * Check a manifest: structural errors make it INVALID; any owner input still
 * null makes it BLOCKED, naming each missing input and what it is needed for.
 * `exists` checks that referenced scenario files are present.
 */
export async function checkOnboarding(raw: unknown, exists: (path: string) => Promise<boolean>): Promise<OnboardingCheck> {
  const parsed = TargetOnboarding.safeParse(raw);
  if (!parsed.success) {
    return { status: 'INVALID', items: parsed.error.issues.map((i) => ({ input: i.path.join('.') || '(manifest)', state: 'invalid' as const, use: '', detail: i.message })) };
  }
  const m = parsed.data;
  const items: OnboardingCheck['items'] = [];
  for (const [input, use] of Object.entries(ONBOARDING_INPUTS) as Array<[keyof typeof ONBOARDING_INPUTS, string]>) {
    if (m[input] === null) items.push({ input, state: 'missing', use, detail: 'to be supplied by the application owner' });
    else items.push({ input, state: 'provided', use });
  }
  if (m.application.owner_contact === null) items.unshift({ input: 'application.owner_contact', state: 'missing', use: 'who supplies and approves the inputs below' });
  for (const j of m.journeys ?? []) {
    if (!(await exists(j.scenario_file))) items.push({ input: `journeys.${j.id}.scenario_file`, state: 'invalid', use: ONBOARDING_INPUTS.journeys, detail: `${j.scenario_file} does not exist` });
  }
  if (m.profiles?.browsers.some((b) => b !== 'chromium') && m.artifacts?.model_sharing === 'sanitized_images') {
    items.push({ input: 'profiles.browsers', state: 'provided', use: ONBOARDING_INPUTS.profiles, detail: 'screenshots on non-Chromium engines are withheld: closed shadow roots cannot be inventoried there' });
  }
  const status = items.some((i) => i.state === 'invalid') ? 'INVALID' : items.some((i) => i.state === 'missing') ? 'BLOCKED' : 'READY';
  return { status, items };
}
