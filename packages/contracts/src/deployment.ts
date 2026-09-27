import { z } from 'zod';
import { HttpsUrl, Sha } from './common.ts';

export const DeploymentProvider = z.enum(['github', 'vercel', 'pipeline', 'manual']);
export const ReadinessType = z.enum(['deployment_status_success', 'provider_ready', 'pipeline_job_success', 'manual']);

/**
 * Normalized, *untrusted* deployment event as received from a provider or CI.
 * Nothing here is accepted as truth until it is verified against trusted
 * provider metadata and stored as a {@link VerifiedVersionManifest}.
 */
export const DeploymentEnvelope = z.object({
  schema_version: z.literal(1),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
  repository_id: z.union([z.string().min(1), z.number().int()]).transform(String),
  provider: DeploymentProvider,
  delivery_id: z.string().min(1),
  deployment_id: z.string().min(1),
  environment: z.string().min(1),
  immutable_url: HttpsUrl,
  commit_sha: Sha,
  artifact_digest: z.string().optional(),
  observed_at: z.string().datetime(),
  readiness_type: ReadinessType,
  event_provenance: z.object({
    kind: z.enum(['webhook_signature', 'ci_identity', 'api_token', 'local']),
    verified: z.boolean(),
  }),
  backend_revision: z.string().optional(),
  config_digest: z.string().optional(),
  schema_revision: z.string().optional(),
});
export type DeploymentEnvelope = z.infer<typeof DeploymentEnvelope>;

/** Deployment identity after independent verification; persisted separately from the envelope. */
export const VerifiedVersionManifest = z.object({
  deployment_id: z.string(),
  environment: z.string(),
  immutable_url: HttpsUrl,
  commit_sha: Sha,
  verified_at: z.string().datetime(),
  verification: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  backend_revision: z.string().optional(),
  config_digest: z.string().optional(),
});
export type VerifiedVersionManifest = z.infer<typeof VerifiedVersionManifest>;

export interface ExecutionKey {
  tenant_id: string;
  project_id: string;
  provider: string;
  deployment_id: string;
  suite_revision: string;
  execution_profile: string;
}

/**
 * Logical-run deduplication key (plan §5.1). Redelivery of the same event maps
 * to the same key; a deliberate rerun is a new attempt of the same logical run.
 */
export function executionDedupKey(k: ExecutionKey): string {
  return [k.tenant_id, k.project_id, k.provider, k.deployment_id, k.suite_revision, k.execution_profile]
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/**
 * A manifest is usable for execution only if every recorded check passed and
 * the envelope's claims match it exactly.
 */
export function manifestMatchesEnvelope(m: VerifiedVersionManifest, e: DeploymentEnvelope): string[] {
  const problems: string[] = [];
  if (m.deployment_id !== e.deployment_id) problems.push('deployment_id mismatch');
  if (m.environment !== e.environment) problems.push('environment mismatch');
  if (m.commit_sha !== e.commit_sha) problems.push('commit_sha mismatch');
  if (m.immutable_url !== e.immutable_url) problems.push('immutable_url mismatch');
  for (const v of m.verification) if (!v.ok) problems.push(`verification failed: ${v.check}`);
  if (m.verification.length === 0) problems.push('no verification checks recorded');
  return problems;
}
