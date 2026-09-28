# Autonomous QA

A web testing service that combines approved, repeatable regression journeys
with bounded System One (S1)–guided exploration, triggered automatically by
deployments. A deterministic controller owns deployment identity, fixtures,
permissions, browser actions, verification, verdicts and release status; model
providers only return typed proposals.

The design is specified in [`docs/implementation-plan.md`](docs/implementation-plan.md);
[`docs/acceptance.md`](docs/acceptance.md) maps each release-readiness criterion
to the tests that demonstrate it.

## Status

Readiness is tracked per requirement/finding in [`docs/acceptance-inventory.json`](docs/acceptance-inventory.json)
using the states `IMPLEMENTATION_PENDING`, `IMPLEMENTED_OFFLINE_VERIFIED`,
`LIVE_VERIFICATION_REQUIRED`, `QUALIFIED_FOR_PROFILE` and `BLOCKED`. An
independent audit (`docs/evidence/audit-2026-09-27/`) found gaps F01–F10 in the
first implementation; its probes run as the mandatory `audit` lane
(`tests/audit/`). Nothing is described as complete unless its lane evidence
supports it.

## Quick start (local)

```bash
npm ci
npx playwright install chromium        # skip if a matching Chromium is present
npm run typecheck && npm test          # unit tests
DATABASE_URL=postgres://… npm run test:e2e   # browser + service tests (service tests skip without a DB)

npm run qa -- validate
npm run qa -- demo                                   # fixture app + suite in-process
npm run qa -- demo --defects total_off_by_one        # watch the gate hold
npm run qa -- baseline pending --run .qa-runs/<run>  # visual checkpoints awaiting approval
```

## Running the service

See [`docs/operations.md`](docs/operations.md). In short:

```bash
export DATABASE_URL=… QA_SUITE_BASE_DIR=/srv/qa-specs QA_ARTIFACT_DIR=/srv/qa-artifacts   # or QA_S3_*
export GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=…   # or GITHUB_TOKEN
npm run qa -- migrate
npm run qa -- bootstrap --tenant acme --project shop --config project.yaml --token admin:root
npm run qa -- serve-api --port 8080     # API, webhooks, /dashboard
npm run qa -- serve-worker              # jobs, outbox, sweepers
```

Deployments arrive via `POST /v1/deployment-events`, `POST /v1/webhooks/github`
or `POST /v1/webhooks/vercel/:project`; results are published as the required
check `autonomous-qa/<project>/<environment>/required` on the exact SHA, and
promotion controllers query `GET /v1/gate`.

## Layout

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Schemas and pure logic: scenarios, policy, project config, deployment envelope, verdicts, lifecycle, release gate, selection manifest |
| `packages/browser` | Locators, step executor, profiles and launch, observation + node registry |
| `packages/oracles` | Fixture client; UI, backend, visual, a11y, layout and keyboard assertions |
| `packages/evidence` | Redacted event log, checksummed artifacts, JUnit/HTML, fs/S3 artifact stores |
| `packages/s1`, `packages/s2` | Provider-neutral S1 model, validation, providers (TypeSafe, HTTP, breaker, failover); typed S2 proposals |
| `packages/gate` | Policy-first gate; calibrated stage 5 for pinned configurations |
| `packages/quality` | Baselines, pixel diff, geometry, axe, keyboard, findings ledger, UX hypotheses |
| `packages/coverage` | Requirement graph, diff providers, impact selection, usage/transition learning, proposals |
| `packages/compiler` | Journey compilation, Playwright export, restricted validation, locator repairs |
| `packages/calibration` | Labels, grouped splits, calibrator, exact bounds, registry, canaries, experiments |
| `packages/db`, `packages/integrations`, `packages/orchestrator` | Postgres + migrations; GitHub/Vercel; ingestion, jobs, outbox, reviews, sweepers, quotas |
| `apps/api`, `apps/worker`, `apps/cli` | Fastify API + dashboard; runners and drivers; `qa` command |
| `fixtures/test-app` | Controlled shop with 16 switchable seeded defects and a fixture API |
| `specs/` | Policy, fixture catalog, coverage graph, scenarios, exploration, proposals |
| `evals/` | Labeling and calibration guide, decision-config example |

## Verdicts

Only `PASS` satisfies a release gate, and only when every expected (scenario,
profile) case from the selection manifest is present and passed. Missing
shards, fail-then-pass (`FLAKY`, held for critical journeys), `BLOCKED`,
`ERROR`, pending visual review, cleanup failures, revision drift, supersession
and stale suite revisions all hold the gate. Exploration is advisory. A `PASS`
covers only the listed requirements and assertions.
