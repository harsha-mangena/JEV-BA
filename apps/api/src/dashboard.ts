import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CaseResult } from '@qa/contracts';
import { ApiError, type Orchestrator, type Principal, type ReviewService } from '@qa/orchestrator';
import { contentType } from './routes.ts';

const h = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COOKIE = 'qa_session';

function cookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const csrfFor = (token: string) => createHmac('sha256', token).update('qa-dashboard-csrf').digest('hex');

function page(title: string, body: string, p?: Principal): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Autonomous QA</title>
<style>:root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#ddd;--pass:#05603a;--fail:#a4001d;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#eee;--muted:#aaa;--line:#333;--pass:#5fd49a;--fail:#ff7a8a;--warn:#f0b64d}}
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:1100px;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
a{color:inherit}nav{display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:16px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:normal}
.PASS,.COMPLETED.ok{color:var(--pass)}.FAIL,.ERROR,.BLOCKED{color:var(--fail)}.FLAKY,.NEEDS_REVIEW,.SUPERSEDED,.CANCELLED,.pending{color:var(--warn)}
img{max-width:100%;border:1px solid var(--line)}button,input,select{font:inherit;padding:4px 8px}form.inline{display:inline}</style></head>
<body>${p ? `<nav><strong>Autonomous QA</strong><a href="/dashboard">Runs</a><span>${h(p.tenant_id)} · ${h(p.role)}</span><form class="inline" method="post" action="/dashboard/logout"><button>Sign out</button></form></nav>` : ''}
<h1>${h(title)}</h1>${body}</body></html>`;
}

/**
 * Minimal server-rendered dashboard: run history, evidence, pending visual
 * baselines and findings. Session = API token in an HttpOnly, SameSite=Strict
 * cookie; every form carries a CSRF token derived from it. Roles are enforced
 * by the same service methods as the API.
 */
export async function registerDashboard(app: FastifyInstance, orch: Orchestrator, review: ReviewService): Promise<void> {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  const session = async (req: FastifyRequest): Promise<{ p: Principal; token: string }> => {
    const token = cookie(req, COOKIE);
    if (!token) throw new ApiError(401, 'unauthenticated', 'sign in required');
    return { p: await orch.authenticate(token), token };
  };
  const html = (reply: FastifyReply, body: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'").send(body);
  const checkCsrf = (token: string, given: unknown) => {
    const a = Buffer.from(csrfFor(token));
    const b = Buffer.from(String(given ?? ''));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(403, 'csrf', 'invalid form token');
  };
  const guard = <T extends FastifyRequest>(fn: (req: T, reply: FastifyReply, s: { p: Principal; token: string }) => Promise<unknown>) => async (req: T, reply: FastifyReply) => {
    try {
      return await fn(req, reply, await session(req));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return reply.redirect('/dashboard/login', 303);
      if (e instanceof ApiError) return html(reply, page('Error', `<p>${h(e.message)}</p>`), e.status);
      throw e;
    }
  };

  app.get('/dashboard/login', async (_req, reply) =>
    html(reply, page('Sign in', `<form method="post" action="/dashboard/login"><label>API token <input type="password" name="token" autocomplete="off" required></label> <button>Sign in</button></form><p>Tokens are issued by an administrator (POST /v1/tokens).</p>`)),
  );
  app.post('/dashboard/login', async (req, reply) => {
    const token = String((req.body as { token?: string }).token ?? '');
    try {
      await orch.authenticate(token);
    } catch {
      return html(reply, page('Sign in', '<p class="FAIL">Invalid token.</p><p><a href="/dashboard/login">Try again</a></p>'), 401);
    }
    const secure = req.protocol === 'https' ? '; Secure' : '';
    return reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`).redirect('/dashboard', 303);
  });
  app.post('/dashboard/logout', async (_req, reply) => reply.header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`).redirect('/dashboard/login', 303));

  app.get(
    '/dashboard',
    guard(async (_req, reply, { p }) => {
      const runs = await review.listRuns(p, 100);
      const rows = runs
        .map(
          (r) => `<tr><td><a href="/dashboard/runs/${h(r.id)}">${h(r.id)}</a></td><td>${h(r.project_id)}</td><td>${h(r.environment)}</td><td><code>${h(String(r.commit_sha).slice(0, 12))}</code></td>
<td class="${h(r.state)} ${r.gate?.eligible ? 'ok' : ''}">${h(r.state)}${r.state === 'COMPLETED' ? (r.gate?.eligible ? ' · eligible' : ' · held') : ''}</td><td>${h(r.message ?? '')}</td><td>${h(new Date(r.created_at).toISOString())}</td></tr>`,
        )
        .join('');
      return html(reply, page('Runs', `<div class="scroll"><table><thead><tr><th>Run</th><th>Project</th><th>Env</th><th>Commit</th><th>State</th><th>Summary</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`, p));
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/dashboard/runs/:id',
    guard(async (req, reply, { p, token }) => {
      const { run, deployment, cases } = await orch.getRun(p, req.params.id);
      const csrf = csrfFor(token);
      const canReview = p.role === 'reviewer' || p.role === 'admin';
      const caseRows = (cases as Array<{ attempt: number; scenario_id: string; execution_profile: string; verdict: string; result: CaseResult; run_dir?: string }>)
        .map((c) => {
          const pending = c.result.assertions.filter((a) => a.type === 'visual_match' && (a.status === 'needs_review' || a.status === 'failed'));
          const shots = c.result.artifacts
            .filter((a) => a.kind === 'screenshot' || a.kind === 'visual_candidate' || a.kind === 'visual_diff')
            .map((a) => `<a href="/dashboard/artifacts/${h(run.id)}/${h(runDirOf(c))}/${h(a.path)}">${h(a.path.split('/').pop())}</a>`)
            .join(' · ');
          const approve = pending
            .map((a) => {
              const cp = (a.expected as { key?: { checkpoint: string }; checkpoint?: string })?.key?.checkpoint;
              return cp && canReview && c.attempt === run.attempt
                ? `<form class="inline" method="post" action="/dashboard/runs/${h(run.id)}/approve-baseline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="scenario_id" value="${h(c.scenario_id)}"><input type="hidden" name="execution_profile" value="${h(c.execution_profile)}"><input type="hidden" name="checkpoint" value="${h(cp)}"><button>Approve “${h(cp)}” baseline</button></form>`
                : '';
            })
            .join(' ');
          const failed = c.result.assertions.filter((a) => a.status !== 'passed').map((a) => `${h(a.milestone_id)}#${a.index} ${h(a.type)}: ${h(a.status)}`).join('<br>');
          return `<tr><td>${c.attempt}</td><td>${h(c.scenario_id)}</td><td>${h(c.execution_profile)}</td><td class="${h(c.verdict)}">${h(c.verdict)}</td><td>${h(c.result.reason ?? '')} ${h(c.result.message ?? '')}<br>${failed}</td><td>${shots} ${approve}</td></tr>`;
        })
        .join('');
      const m = run.selection_manifest;
      const body = `<p>Deployment <code>${h(deployment?.provider_deployment_id)}</code> at <code>${h(deployment?.immutable_url)}</code> · commit <code>${h(run.commit_sha)}</code> · attempt ${run.attempt}</p>
<p class="${h(run.state)}">State: <strong>${h(run.state)}</strong>${run.gate ? ` · gate ${run.gate.eligible ? '<strong class="PASS">ELIGIBLE</strong>' : '<strong class="FAIL">HELD</strong>'}` : ''}</p>
${run.gate?.reasons?.length ? `<ul>${run.gate.reasons.map((r: string) => `<li>${h(r)}</li>`).join('')}</ul>` : ''}
${m ? `<details><summary>Selection (${h(m.strategy)}): ${m.cases.length} case(s), ${m.omitted.length} omitted, ${m.gaps.length} gap(s)</summary><ul>${m.explanation.map((e: string) => `<li>${h(e)}</li>`).join('')}</ul><ul>${m.omitted.map((o: { scenario_id: string; reason: string }) => `<li>omitted ${h(o.scenario_id)}: ${h(o.reason)}</li>`).join('')}</ul></details>` : ''}
<div class="scroll"><table><thead><tr><th>Attempt</th><th>Scenario</th><th>Profile</th><th>Verdict</th><th>Detail</th><th>Evidence</th></tr></thead><tbody>${caseRows}</tbody></table></div>
<p><a href="/dashboard/findings?project_id=${h(run.project_id)}">Findings for ${h(run.project_id)}</a></p>`;
      return html(reply, page(`Run ${run.id}`, body, p));
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/dashboard/runs/:id/approve-baseline',
    guard(async (req, reply, { p, token }) => {
      const b = req.body as Record<string, string>;
      checkCsrf(token, b.csrf);
      await review.approveBaseline(p, req.params.id, { scenario_id: b.scenario_id ?? '', execution_profile: b.execution_profile ?? '', checkpoint: b.checkpoint ?? '' });
      return reply.redirect(`/dashboard/runs/${encodeURIComponent(req.params.id)}`, 303);
    }),
  );

  app.get<{ Querystring: { project_id?: string } }>(
    '/dashboard/findings',
    guard(async (req, reply, { p, token }) => {
      const projectId = req.query.project_id ?? p.project_id;
      if (!projectId) throw new ApiError(400, 'project_required', 'choose a project');
      const rows = await review.listFindings(p, projectId);
      const csrf = csrfFor(token);
      const body = `<div class="scroll"><table><thead><tr><th>Kind</th><th>Scenario / checkpoint</th><th>Certainty</th><th>Summary</th><th>Seen</th><th>Status</th></tr></thead><tbody>${rows
        .map(
          (f) => `<tr><td>${h(f.kind)}</td><td>${h(f.scenario_id)} / ${h(f.checkpoint)} (${h(f.execution_profile)})</td><td>${h(f.certainty)}</td><td>${h(f.summary)}</td><td>${f.occurrences}×</td>
<td>${h(f.status)}${f.review_note ? ` — ${h(f.review_note)}` : ''}${p.role === 'reviewer' || p.role === 'admin' ? `<form method="post" action="/dashboard/findings/${h(f.id)}/review"><input type="hidden" name="csrf" value="${csrf}"><select name="status"><option>open</option><option>accepted</option><option>dismissed</option></select> <input name="note" placeholder="note"> <button>Save</button></form>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div><p>Findings are hypotheses with evidence; "suspected" means not yet reproduced.</p>`;
      return html(reply, page(`Findings · ${projectId}`, body, p));
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/dashboard/findings/:id/review',
    guard(async (req, reply, { p, token }) => {
      const b = req.body as Record<string, string>;
      checkCsrf(token, b.csrf);
      const f = await review.reviewFinding(p, req.params.id, (b.status as 'open' | 'accepted' | 'dismissed') ?? 'open', b.note ?? '');
      return reply.redirect(`/dashboard/findings?project_id=${encodeURIComponent((f as { project_id: string }).project_id)}`, 303);
    }),
  );

  app.get<{ Params: { id: string; '*': string } }>(
    '/dashboard/artifacts/:id/*',
    guard(async (req, reply, { p }) => {
      const bytes = await review.artifact(p, req.params.id, req.params['*']);
      return reply.type(contentType(req.params['*'])).header('content-security-policy', "default-src 'none'").send(bytes);
    }),
  );
}

function runDirOf(c: { run_dir?: string }): string {
  return c.run_dir ?? '';
}
