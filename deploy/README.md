# Deploying JEV-BA

One container image (`Dockerfile`) runs every role from source with `tsx` on the
pinned Playwright base image (Chromium matching `@playwright/test` 1.56.1):

| Role | Command | Notes |
|---|---|---|
| migrations | `qa migrate` | One-shot; applies `packages/db/migrations/*.sql` in order, each in a transaction. |
| control API | `qa serve-api --port 8080` | Applies pending migrations, runs startup checks, refuses to start on any failure. |
| worker | `qa serve-worker --out /var/qa/runs` | Runs startup checks (database, migrations, suites, fixture tokens, browser, S1 probe when autonomy can act) and refuses to start on any failure. Run several for throughput; admission and fencing are enforced in PostgreSQL. |
| diagnostics | `qa doctor --role api\|worker` | The same checks without starting a server; non-zero exit on failure. |

`docker-compose.yml` wires PostgreSQL, migrations, the API, a worker and two
fixture-shop deployments (clean and defective) used by the demo flow.

## Migrations

| File | Adds |
|---|---|
| `001_orchestration.sql` | tenants, projects, tokens, deployments, runs, jobs, outbox, cleanup obligations |
| `002_service.sql` | findings, baseline/scenario approvals, provider usage, retention |
| `003_intents_fencing.sql` | `action_intents`, `intent_transitions`, `effect_receipts`, `jobs.fence`, `case_results.fence` |
| `004_lineage_promotions.sql` | `runs.execution_snapshot`, `runs.generation`, `promotion_decisions` |
| `005_visual_cas.sql` | unique baseline approval version (compare-and-set) |

Upgrade: stop workers (SIGTERM; they finish the current job), run `qa migrate`,
start the new API, then the new workers. Runs selected under an older execution
snapshot or engine version no longer qualify for promotion and must be re-run.

## Configuration keys

| Key | Role | Meaning |
|---|---|---|
| `DATABASE_URL` | all | PostgreSQL connection string. |
| `QA_SUITE_BASE_DIR` | api, worker | Directory project suite paths resolve against (image: `/app`). |
| `QA_ARTIFACT_DIR` / `QA_S3_*` | api, worker | Evidence store (filesystem, or S3-compatible: `QA_S3_BUCKET`, `QA_S3_ENDPOINT`, `QA_S3_REGION`, `QA_S3_PREFIX`, `QA_S3_PATH_STYLE`, AWS credentials). |
| `<fixture_api.token_env>` | worker | Per-project fixture service token (name set in project config, e.g. `QA_FIXTURE_TOKEN_SHOP`). |
| `<webhook_secret_ref>` | api | Per-project webhook secret (name set at bootstrap). |
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY[_FILE]`, or `GITHUB_TOKEN`; `GITHUB_API_URL` | api, worker | Deployment verification and commit statuses. |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | api, worker | Vercel deployment verification and checks. |
| `QA_METRICS_TOKEN` | api | Enables `GET /metrics` (Prometheus text) for this bearer token (≥16 characters); unset = disabled (404). |
| `QA_LEASE_SECONDS` | worker | Job lease length (default 60); an expired lease is re-leased under a new fence. |
| `QA_SWEEP_INTERVAL_MS` | worker | Cleanup/retention sweep interval (default 300000). |
| `QA_AUTONOMY_MODE` | worker | `shadow` (default: decide and record, never act), `heuristic_staging` (uncalibrated, never in production), `calibrated` (needs `QA_CALIBRATION_DIR`). |
| `QA_S1_PROVIDER`, `QA_S1_API_KEY`, `QA_S1_MODEL`, `QA_S1_ENDPOINT`, `QA_S1_TIMEOUT_MS`, `QA_S1_RETRIES` | worker | System One (TypeSafe/Jev: `typesafe`, default model `jev-latest`, official endpoint). |
| `QA_S2_PROVIDER=anthropic`, `QA_S2_MODEL`, `ANTHROPIC_API_KEY` | worker | Vision System Two (Claude Messages API). |
| `QA_VISUAL_REVIEWER=anthropic` | worker | Advisory vision review hints on failed visual comparisons. |
| `QA_CALIBRATION_DIR` | worker | Calibration registry for calibrated mode. |

## Unattended demo flow

```sh
docker build -t jev-ba/qa:local .
node deploy/demo/run-demo.mjs            # writes docs/evidence/phase10/demo-flow.json
```

The script brings the stack up with `deploy/demo/demo.env` (demo-only values),
bootstraps a tenant/project/tokens, and then:

1. submits the clean deployment → all required cases PASS → the gate opens →
   a promotion decision is consumed once (a replay is refused with 409);
2. submits the defective deployment (`total_off_by_one`) → checkout FAILs → the
   gate is held → promotion refused; an older clean decision is refused too
   (not the current candidate, newer generation);
3. submits a third deployment, SIGKILLs the worker container while a checkout
   intent is `DISPATCHING`, starts a replacement; the lease expires, the shard is
   re-leased under a new fence, the intent is reconciled from the application
   (`RECONCILED` with one order receipt), the run completes with an open gate,
   and the dead worker's fixtures are swept.

In environments behind a TLS-intercepting proxy, pass the proxy and CA to the
build: `docker build --build-arg HTTPS_PROXY=… --secret id=npm_ca,src=<ca.pem> …`.
