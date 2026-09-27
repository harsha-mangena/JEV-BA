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

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Contracts, fixture app with seeded defects, specs, decision records | Done |
| 1 | Deterministic Playwright runner, independent verdicts, evidence, reports, CLI | Done |
| 2 | Observation model, node registry, S1 adapter, response validation | Done — live TypeSafe wire format unverified (see below) |
| 3 | Policy-first gate, S2 escalation, bounded autonomy | Done |
| 4 | Deployment-triggered orchestration (Postgres, jobs, outbox, GitHub, exact-SHA checks) | Done |
| 5 | Visual baselines, layout geometry, axe, keyboard, UX hypotheses | Done |
| 6 | Change impact selection, coverage learning, validated test proposals | Done |
| 7 | Regression compilation, Playwright export, controlled repairs | Done |
| 8 | Calibration, held-out evaluation, drift canaries, comparative experiments | Done — needs real labeled data |
| 9 | Onboarding, roles, quotas, fair scheduling, sweepers, S3, dashboard, Vercel, read-only production | Done |

**Honest limits.**
- The **TypeSafe/Jev wire format is unverified**: its API reference was not
  reachable from the build environment, so `TypeSafeProvider` is built from
  public descriptions and flagged `WIRE_FORMAT_VERIFIED = false`. Run
  `qa s1 probe` / `npm run test:live` against the real endpoint before enabling
  autonomy; mismatches surface as invalid heads (abstain), never as actions.
- **No calibration ships.** The gate runs `heuristic-v0` until you label real
  decisions and run `qa calibrate` (see [`evals/README.md`](evals/README.md)).
- **Vercel** endpoints follow Vercel's public docs but were exercised only
  against a local double. Firefox/WebKit profiles exist but only Chromium is
  installed in this environment; missing browsers are reported as `BLOCKED`.

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
