import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyVercelSignature } from '@qa/integrations';
import { ApiError, ReviewService, type Orchestrator, type Principal } from '@qa/orchestrator';
import { registerDashboard } from './dashboard.ts';

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
};

/** Phase 9 routes: onboarding, tokens, audit, reviews, artifacts, Vercel ingress and the dashboard. */
export async function registerServiceRoutes(app: FastifyInstance, orch: Orchestrator): Promise<void> {
  const review = new ReviewService(orch);
  const auth = (req: FastifyRequest): Promise<Principal> => orch.authenticate(bearer(req));
  const env = orch.deps.env ?? process.env;

  app.post('/v1/projects', async (req, reply) => {
    const body = z
      .object({ id: z.string(), repository_id: z.union([z.string(), z.number()]).transform(String).optional(), repository_full_name: z.string().optional(), config: z.record(z.unknown()), webhook_secret_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), github_installation_id: z.number().int().optional() })
      .strict()
      .parse(req.body);
    return reply.code(201).send(await review.upsertProject(await auth(req), { ...body, config: body.config }));
  });
  app.post('/v1/tokens', async (req, reply) => {
    const body = z.object({ role: z.enum(['admin', 'submitter', 'reviewer', 'viewer']), label: z.string(), project_id: z.string().nullable().optional() }).strict().parse(req.body);
    return reply.code(201).send(await review.createToken(await auth(req), body));
  });
  app.delete<{ Params: { label: string } }>('/v1/tokens/:label', async (req) => review.revokeToken(await auth(req), req.params.label));
  app.get('/v1/audit', async (req) => review.audit(await auth(req), Number((req.query as { limit?: string }).limit ?? 100)));

  app.get('/v1/runs', async (req) => review.listRuns(await auth(req), Number((req.query as { limit?: string }).limit ?? 50)));
  app.get<{ Params: { id: string; '*': string } }>('/v1/runs/:id/artifacts/*', async (req, reply) => {
    const bytes = await review.artifact(await auth(req), req.params.id, req.params['*']);
    return reply.type(contentType(req.params['*'])).header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'").send(bytes);
  });

  app.post<{ Params: { runId: string } }>('/v1/baselines/:runId/approve', async (req) => {
    const body = z.object({ scenario_id: z.string(), execution_profile: z.string(), checkpoint: z.string() }).strict().parse(req.body);
    return review.approveBaseline(await auth(req), req.params.runId, body);
  });
  app.get('/v1/findings', async (req) => {
    const q = z.object({ project_id: z.string(), status: z.enum(['open', 'accepted', 'dismissed']).optional() }).parse(req.query);
    return review.listFindings(await auth(req), q.project_id, q.status);
  });
  app.get<{ Params: { id: string } }>('/v1/findings/:id', async (req) => review.getFinding(await auth(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/findings/:id/review', async (req) => {
    const body = z.object({ status: z.enum(['open', 'accepted', 'dismissed']), note: z.string().max(2000).default('') }).strict().parse(req.body);
    return review.reviewFinding(await auth(req), req.params.id, body.status, body.note);
  });
  app.post<{ Params: { id: string } }>('/v1/scenarios/:id/approve', async (req) => {
    const body = z.object({ project_id: z.string() }).strict().parse(req.body);
    return review.approveScenario(await auth(req), body.project_id, req.params.id);
  });

  /** Vercel webhook (deployment.ready / deployment.succeeded), one URL per project, HMAC-SHA1 signed. */
  app.post<{ Params: { projectId: string } }>('/v1/webhooks/vercel/:projectId', async (req, reply) => {
    const project = await orch.projectById(req.params.projectId);
    const secretRef = project?.config && (project as { webhook_secret_ref: string | null }).webhook_secret_ref;
    const secret = secretRef ? env[secretRef] : undefined;
    if (!project || !secret || !verifyVercelSignature(secret, req.rawBody ?? Buffer.alloc(0), req.headers['x-vercel-signature'] as string | undefined)) {
      throw new ApiError(401, 'bad_signature', 'webhook signature verification failed');
    }
    const body = req.body as { id?: string; type?: string; payload?: { deployment?: { id: string; url: string; meta?: Record<string, string> }; target?: string | null } };
    if (body.type !== 'deployment.ready' && body.type !== 'deployment.succeeded') return reply.code(202).send({ ignored: body.type });
    const d = body.payload?.deployment;
    if (!d) throw new ApiError(400, 'invalid_payload', 'missing deployment');
    const result = await orch.submitDeployment(
      { tenant_id: project.tenant_id, project_id: project.id, role: 'submitter', actor: 'vercel-webhook' },
      project,
      { provider: 'vercel', repository: project.repository_full_name, repository_id: null, deployment_id: d.id, environment: body.payload?.target === 'production' ? 'production' : 'preview', commit_sha: d.meta?.githubCommitSha ?? '', candidate_url: `https://${d.url}` },
      { provider: 'vercel', delivery_id: body.id ?? `vercel:${d.id}`, payload_digest: createHash('sha256').update(req.rawBody ?? Buffer.alloc(0)).digest('hex') },
    );
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  await registerDashboard(app, orch, review);
}

export function contentType(path: string): string {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'application/json';
  if (path.endsWith('.xml')) return 'application/xml';
  if (path.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}
