# ADR 0003 — TypeScript, Playwright, Zod; run from source

Status: accepted

- One runtime (Node 22, TypeScript) for controller, workers, schemas and CLI, so
  Playwright, axe-core and typed contracts integrate directly.
- Workspaces export `src/index.ts`; code runs via `tsx` and `vitest` without a
  build step. `tsc --noEmit` is the type gate. A compiled distribution can be
  added when the service is packaged (Phase 9).
- `@playwright/test` is pinned to an exact version (`1.56.1`) so browser
  binaries, fonts and rendering are reproducible. `QA_CHROMIUM_EXECUTABLE`
  overrides the binary where a matching Chromium is preinstalled.
- No database or queue yet: Phases 0–3 run in-process. PostgreSQL with a
  transactional outbox arrives with deployment orchestration (Phase 4).
