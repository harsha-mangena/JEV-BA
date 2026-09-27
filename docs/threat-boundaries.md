# Threat boundaries

| Boundary | Threat | Control in this codebase |
| --- | --- | --- |
| Page content → model | Prompt injection in page text | Page state is serialized into a separate context block labelled untrusted; question prompts contain only controller text; models return typed choices over observed node keys only |
| Model → browser | Model proposes a forbidden or destructive action | Gate stage 2 (permission) precedes any score; mutation intents require scenario + environment authorization; unbound controls are `unknown` and denied by default |
| S2 → browser | Arbitrary selectors, scripts, permission or assertion edits | Strict Zod union; extra fields rejected; selected node must be an observed candidate; re-enters freshness and permission |
| Controller → application | Off-origin requests, data exfiltration | Per-context route allow-list derived from the verified candidate origin; everything else aborted and logged |
| Fixture service | Unauthenticated fixture/defect manipulation | Token header required, compared in constant time; fixture app refuses to start with a short token |
| Evidence | Secrets in reports, logs, traces | Redactor registers every provisioned secret and session value; sensitive keys are masked; traces disabled when secrets are typed; password field values never leave the page during observation |
| Deployment events | Spoofed or replayed events, wrong revision | Bearer tokens (hashed at rest), HMAC-SHA256 (GitHub) / HMAC-SHA1 (Vercel) signatures over the raw body; claims verified against provider APIs; delivery and logical-run dedup; URL patterns, no credentials, public IPs only unless allowed; revision checked at readiness and before/after execution |
| Tenancy | Cross-tenant reads or writes | Every query scoped by tenant (and project for scoped tokens); cross-tenant ids return 404; artifacts served only for visible runs and only under the run's key prefix |
| Dashboard | Session theft, CSRF, XSS | HttpOnly SameSite=Strict cookie; HMAC CSRF token on every form; all output escaped; CSP `default-src 'self'` |
| Reviews | Unreviewed baselines/tests blessing current behaviour | Reviewer role; approvals tied to commit SHA and evidence checksum; proposals need non-observed oracles; repairs cannot touch assertions or policy; audit log |
| Provider cost/outage | Runaway usage, cascading failures | Per-tenant daily quota, circuit breaker, failover only to certified providers; outages → ERROR |
| Retries | Duplicate side effects | No action is ever retried; retries are new attempts with fresh fixtures; a post-dispatch failure is `effect_unknown` → ERROR |
| Result integrity | Missing shards or stale results turning green | Gate requires every expected case exactly once; unexpected results hold; first failure preserved as FLAKY |
