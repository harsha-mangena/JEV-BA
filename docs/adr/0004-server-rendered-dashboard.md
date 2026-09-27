# ADR 0004 — Server-rendered dashboard instead of a React SPA

Status: accepted (deviation from plan §4.1)

The plan suggested a small React dashboard. The dashboard's job is review:
run history, evidence, baseline approval and finding triage. A server-rendered
view inside the API process needs no build pipeline, shares the exact
authorization code paths of the API, and makes CSRF and content-security
policy straightforward (HttpOnly SameSite=Strict session cookie, HMAC form
tokens, `default-src 'self'`). A client framework can be added later against
the same JSON API without changing authority boundaries.
