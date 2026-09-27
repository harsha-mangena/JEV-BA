import { randomBytes } from 'node:crypto';
import { ProjectConfig, parseWith } from '@qa/contracts';
import type { Db } from '@qa/db';
import { tokenHash } from './service.ts';
import type { Role } from './types.ts';

export interface BootstrapInput {
  tenant: { id: string; name?: string; max_concurrent_jobs?: number };
  project: { id: string; repository_id?: string; repository_full_name?: string; config: unknown; webhook_secret_ref?: string; github_installation_id?: number };
  tokens?: Array<{ role: Role; label: string; project_scoped?: boolean }>;
}

export const newToken = () => `qa_${randomBytes(24).toString('base64url')}`;

/** Create or update a tenant and project and mint tokens. Plaintext tokens are returned once and stored only as hashes. */
export async function bootstrapProject(db: Db, input: BootstrapInput): Promise<Record<string, string>> {
  const config = parseWith(ProjectConfig, input.project.config, `project ${input.project.id}`);
  return db.tx(async (c) => {
    await c.query(
      `insert into tenants(id, name, max_concurrent_jobs) values ($1,$2,$3) on conflict (id) do update set name=excluded.name, max_concurrent_jobs=excluded.max_concurrent_jobs`,
      [input.tenant.id, input.tenant.name ?? input.tenant.id, input.tenant.max_concurrent_jobs ?? 4],
    );
    await c.query(
      `insert into projects(id, tenant_id, repository_id, repository_full_name, config, webhook_secret_ref, github_installation_id) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set repository_id=excluded.repository_id, repository_full_name=excluded.repository_full_name, config=excluded.config, webhook_secret_ref=excluded.webhook_secret_ref, github_installation_id=excluded.github_installation_id`,
      [input.project.id, input.tenant.id, input.project.repository_id ?? null, input.project.repository_full_name ?? null, JSON.stringify(config), input.project.webhook_secret_ref ?? null, input.project.github_installation_id ?? null],
    );
    const out: Record<string, string> = {};
    for (const t of input.tokens ?? []) {
      const token = newToken();
      await c.query('insert into api_tokens(token_hash, tenant_id, project_id, role, label) values ($1,$2,$3,$4,$5)', [tokenHash(token), input.tenant.id, t.project_scoped === false ? null : input.project.id, t.role, t.label]);
      out[t.label] = token;
    }
    await c.query('insert into audit_log(tenant_id, actor, action, subject, detail) values ($1,$2,$3,$4,$5)', [input.tenant.id, 'bootstrap', 'project.bootstrap', input.project.id, JSON.stringify({ tokens: (input.tokens ?? []).map((t) => ({ role: t.role, label: t.label })) })]);
    return out;
  });
}
