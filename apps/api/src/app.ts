import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ContractError } from '@qa/contracts';
import { verifyGithubSignature } from '@qa/integrations';
import { ApiError, metricsText, type Orchestrator, type Principal } from '@qa/orchestrator';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    principal?: Principal;
  }
}

/** Payload submitted by CI (see docs/github-ingress.md); every field is an untrusted claim. */
export const DeploymentEventBody = z
  .object({
    schema_version: z.literal(1),
    provider: z.enum(['github', 'vercel', 'pipeline', 'manual']),
    project_id: z.string().optional(),
    repository_id: z.union([z.string(), z.number()]).transform(String).optional(),
    deployment_id: z.union([z.string(), z.number()]).transform(String),
    deployment_status_id: z.union([z.string(), z.number()]).transform(String).optional(),
    environment: z.string().min(1),
    commit_sha: z.string(),
    candidate_url: z.string().url().nullable().optional(),
    ci_run_id: z.union([z.string(), z.number()]).transform(String).optional(),
    /** Lineage channel (e.g. `pr:123`); providers verify it against their own metadata. */
    channel: z.string().regex(/^[\w.:/-]{1,100}$/).optional(),
    /** Pipeline-supplied ordering (larger is newer), e.g. the CI run number. */
    sequence: z.number().int().nonnegative().optional(),
  })
  .strict();

const digest = (b: Buffer | undefined) => createHash('sha256').update(b ?? Buffer.alloc(0)).digest('hex');

export interface ApiOptions {
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  /** Extra routes (dashboard, onboarding, reviews) registered by later phases. */
  extend?: (app: FastifyInstance, orch: Orchestrator) => void | Promise<void>;
}

export async function buildApi(orch: Orchestrator, opts: ApiOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? process.env;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new ApiError(400, 'invalid_json', 'request body is not valid JSON'), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    if (err instanceof ContractError) return reply.code(400).send({ error: 'invalid_contract', message: err.message, detail: err.issues });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  const auth = async (req: FastifyRequest): Promise<Principal> => {
    const h = req.headers.authorization;
    const principal = await orch.authenticate(h?.startsWith('Bearer ') ? h.slice(7) : undefined);
    req.principal = principal;
    return principal;
  };

  app.get('/healthz', async () => ({ ok: true }));
  // Prometheus scrape endpoint; disabled unless QA_METRICS_TOKEN is configured.
  app.get('/metrics', async (req, reply) => {
    const token = env.QA_METRICS_TOKEN;
    if (!token) return reply.code(404).send({ error: 'not_found' });
    const given = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${token}`);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.type('text/plain; version=0.0.4').send(await metricsText(orch.db));
  });

  app.post('/v1/deployment-events', async (req, reply) => {
    const p = await auth(req);
    const body = DeploymentEventBody.parse(req.body);
    const project = body.project_id
      ? await orch.visibleProject(p, body.project_id)
      : body.repository_id
        ? await orch.projectByRepository(body.repository_id)
        : p.project_id
          ? await orch.visibleProject(p, p.project_id)
          : undefined;
    if (!project) throw new ApiError(404, 'not_found', 'no project bound to this event');
    const deliveryId =
      body.provider === 'github' && body.deployment_status_id
        ? `status:${body.deployment_status_id}`
        : ((req.headers['idempotency-key'] as string | undefined) ?? `${body.provider}:${body.deployment_id}:${body.ci_run_id ?? 'manual'}`);
    const result = await orch.submitDeployment(
      p,
      project,
      {
        provider: body.provider,
        repository: project.repository_full_name,
        repository_id: body.repository_id ?? null,
        deployment_id: body.deployment_id,
        ...(body.deployment_status_id ? { deployment_status_id: body.deployment_status_id } : {}),
        environment: body.environment,
        commit_sha: body.commit_sha,
        candidate_url: body.candidate_url ?? null,
        ...(body.channel !== undefined ? { channel: body.channel } : {}),
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
      },
      { provider: body.provider, delivery_id: deliveryId, payload_digest: digest(req.rawBody) },
    );
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  /**
   * GitHub App / repository webhook. Works regardless of which identity created
   * the deployment status — unlike workflow triggers, which GitHub suppresses
   * for events created with GITHUB_TOKEN.
   */
  app.post('/v1/webhooks/github', async (req, reply) => {
    const event = req.headers['x-github-event'];
    const body = req.body as { repository?: { id?: number }; deployment?: { id: number; sha: string; environment: string }; deployment_status?: { id: number; state: string; environment_url?: string } };
    const repoId = body.repository?.id;
    const project = repoId !== undefined ? await orch.projectByRepository(String(repoId)) : undefined;
    const secret = project?.webhook_secret_ref ? env[project.webhook_secret_ref] : undefined;
    if (!project || !secret || !verifyGithubSignature(secret, req.rawBody ?? Buffer.alloc(0), req.headers['x-hub-signature-256'] as string | undefined)) {
      throw new ApiError(401, 'bad_signature', 'webhook signature verification failed');
    }
    if (event === 'ping') return { ok: true };
    if (event !== 'deployment_status') return reply.code(202).send({ ignored: `event ${String(event)}` });
    if (body.deployment_status?.state !== 'success') return reply.code(202).send({ ignored: `state ${body.deployment_status?.state}` });
    const principal: Principal = { tenant_id: project.tenant_id, project_id: project.id, role: 'submitter', actor: 'github-webhook' };
    const result = await orch.submitDeployment(
      principal,
      project,
      {
        provider: 'github',
        repository: project.repository_full_name,
        repository_id: String(repoId),
        deployment_id: String(body.deployment!.id),
        deployment_status_id: String(body.deployment_status.id),
        environment: body.deployment!.environment,
        commit_sha: body.deployment!.sha,
        candidate_url: body.deployment_status.environment_url ?? null,
      },
      { provider: 'github', delivery_id: `status:${body.deployment_status.id}`, payload_digest: digest(req.rawBody) },
    );
    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req) => orch.getRun(await auth(req), req.params.id));
  app.post<{ Params: { id: string } }>('/v1/runs/:id/cancel', async (req) => ({ run: await orch.cancelRun(await auth(req), req.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/runs/:id/retry', async (req) => {
    const { reason } = z.object({ reason: z.string().min(1) }).strict().parse(req.body ?? {});
    return { run: await orch.retryRun(await auth(req), req.params.id, reason) };
  });
  app.get<{ Params: { id: string } }>('/v1/runs/:id/obligations', async (req) => ({ obligations: await orch.obligations(await auth(req), req.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/intents/:id/adjudicate', async (req) => {
    const a = z.object({ resolution: z.enum(['effect_absent', 'effect_present_accepted', 'effect_reverted']), note: z.string().min(1).max(2000) }).strict().parse(req.body ?? {});
    return orch.adjudicateIntent(await auth(req), req.params.id, a);
  });
  app.get('/v1/gate', async (req) => {
    const q = z.object({ project_id: z.string(), environment: z.string(), deployment_id: z.string(), commit_sha: z.string() }).parse(req.query);
    return orch.gateStatus(await auth(req), q);
  });

  app.post('/v1/promotions', async (req, reply) => {
    const q = z.object({ project_id: z.string(), environment: z.string(), deployment_id: z.string(), commit_sha: z.string(), ttl_seconds: z.number().int().positive().optional() }).strict().parse(req.body ?? {});
    return reply.code(201).send(await orch.decidePromotion(await auth(req), q));
  });
  app.post<{ Params: { id: string } }>('/v1/promotions/:id/consume', async (req) => orch.consumePromotion(await auth(req), req.params.id));

  await opts.extend?.(app, orch);
  return app;
}
