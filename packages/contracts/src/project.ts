import { z } from 'zod';
import { ExecutionProfileId } from './scenario.ts';

/** URL patterns like `https://*.vercel.app` or `http://127.0.0.1:*`. `*` never spans a dot in hosts. */
export const UrlPattern = z.string().regex(/^https?:\/\/[^/\s]+$/, 'must be scheme://host[:port] with optional * wildcards');

export const EnvironmentConfig = z
  .object({
    url_patterns: z.array(UrlPattern).min(1),
    /** Loopback/private destinations are refused unless explicitly allowed (isolated runners only). */
    allow_private_network: z.boolean().default(false),
    required_check: z.boolean().default(true),
    /** Production is read-only: no fixture provisioning and no mutations (Phase 9 capability profile). */
    read_only: z.boolean().default(false),
  })
  .strict();
export type EnvironmentConfig = z.output<typeof EnvironmentConfig>;

export const VersionCheck = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), path: z.string().startsWith('/'), field: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('meta'), path: z.string().startsWith('/'), name: z.string().min(1) }).strict(),
]);
export type VersionCheck = z.infer<typeof VersionCheck>;

export const ProjectConfig = z
  .object({
    schema_version: z.literal(1),
    environments: z.record(z.string().min(1), EnvironmentConfig),
    version_check: VersionCheck,
    readiness: z.object({ timeout_seconds: z.number().positive().default(300), interval_seconds: z.number().positive().default(5) }).strict().default({}),
    suite: z
      .object({
        specs_dir: z.string().min(1),
        policy_file: z.string().min(1),
        fixture_catalog: z.string().min(1),
        coverage_file: z.string().min(1).optional(),
        profiles: z.array(ExecutionProfileId).optional(),
        /** Restrict the project's suite to these scenario ids (default: every scenario in specs_dir). */
        scenarios: z.array(z.string().min(1)).optional(),
        shards: z.number().int().positive().default(1),
        retries: z.number().int().nonnegative().default(0),
        concurrency: z.number().int().positive().default(2),
        signed_out_path: z.string().startsWith('/').optional(),
      })
      .strict(),
    fixture_api: z
      .object({
        /** Defaults to the candidate URL. */
        url: z.string().url().optional(),
        /** Name of the environment variable holding the token; the secret itself is never stored in config. */
        token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
      })
      .strict(),
    status: z
      .object({
        context_prefix: z.string().default('autonomous-qa'),
        dashboard_url: z.string().url().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type ProjectConfig = z.output<typeof ProjectConfig>;

export function requiredCheckContext(cfg: ProjectConfig, projectId: string, environment: string): string {
  return `${cfg.status.context_prefix}/${projectId}/${environment}/required`;
}

function patternToRegex(p: string): RegExp {
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^./:]+')}$`);
}

/** Match an origin against a URL pattern. Wildcards never cross a dot, colon or slash. */
export function originMatches(origin: string, pattern: string): boolean {
  return patternToRegex(pattern).test(origin);
}
