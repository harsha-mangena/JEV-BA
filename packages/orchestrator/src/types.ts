import type { ProjectConfig, SelectionManifest } from '@qa/contracts';

export type Role = 'admin' | 'submitter' | 'reviewer' | 'viewer';

export interface Principal {
  tenant_id: string;
  project_id: string | null;
  role: Role;
  actor: string;
}

export interface ProjectRow {
  id: string;
  tenant_id: string;
  repository_id: string | null;
  repository_full_name: string | null;
  config: ProjectConfig;
  webhook_secret_ref: string | null;
  github_installation_id: string | null;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  project_id: string;
  deployment_id: string;
  environment: string;
  commit_sha: string;
  suite_revision: string;
  execution_profile: string;
  dedup_key: string;
  state: string;
  attempt: number;
  selection_manifest: SelectionManifest | null;
  /** The execution contract the run was selected under (see `resolveExecution`). */
  execution_snapshot?: unknown;
  /** Identity of the frozen selection manifest. */
  selection_digest?: string | null;
  /** Lineage within the environment ('default' for single-lineage environments). */
  channel?: string;
  generation?: string | number | null;
  gate: { eligible: boolean; reasons: string[] } | null;
  reason: string | null;
  message: string | null;
  superseded_by: string | null;
  cancel_requested: boolean;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const RANK: Record<Role, number> = { viewer: 0, reviewer: 1, submitter: 1, admin: 3 };

/** Role check. Reviewer and submitter are distinct capabilities, not a hierarchy. */
export function requireRole(p: Principal, ...allowed: Role[]): void {
  if (p.role === 'admin' || allowed.includes(p.role)) return;
  throw new ApiError(403, 'forbidden', `role ${p.role} cannot perform this action`);
}

export function canSeeProject(p: Principal, project: { tenant_id: string; id: string }): boolean {
  return p.tenant_id === project.tenant_id && (p.project_id === null || p.project_id === project.id) && RANK[p.role] >= 0;
}
