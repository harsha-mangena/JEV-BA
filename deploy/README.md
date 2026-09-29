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
| `006_effect_obligations.sql` | intent state `SETTLED`; `action_intents.adjudication` (review obligations) |
| `007_execution_contract.sql` | `runs.selection_digest`, `promotion_decisions.selection_digest` |
| `008_deployment_channels.sql` | `deployment_channels` (lineage lock, generation, current candidate, ordering mode); `channel` on deployments, runs and decisions; `deployments.provider_sequence`; tenant/project-scoped delivery identity |

Upgrade: stop workers (SIGTERM; they finish the current job), run `qa migrate`,
start the new API, then the new workers. Runs selected under an older execution
contract or engine version no longer qualify for promotion and must be re-run
(the contract now covers environment policy, oracle endpoint and adapter,
version verification, frozen baselines and browser builds). Migration 008
renumbers existing run generations consecutively, so promotion decisions taken
before the upgrade are refused; take them again. Delivery records without a
tenant/project are dropped (they could not be scoped). Qualification records
written before this release carry no expiry and no longer authorize calibrated
dispatch: qualify again.

## Operating the release gate

- **Lineage.** Each environment sets `lineage: single` (default; every
  deployment is one lineage) or `lineage: per_channel` (e.g. pull-request
  previews: one lineage per verified provider channel — GitHub `ref`, Vercel
  PR id, or the pipeline's `channel`). A lineage is ordered by verified provider
  sequence (GitHub deployment id, Vercel `createdAt`, the pipeline's
  `sequence`) or, when its deployments carry none, by serialized arrival; an
  older event arriving late is recorded as stale and never tested, and a tie
  holds the lineage until a strictly newer deployment arrives.
- **Promotion.** `POST /v1/promotions` then `POST /v1/promotions/:id/consume`.
  The consume response names the exact `deployment_id`, `commit_sha`, `channel`
  and `generation`; the deployment controller must promote exactly that.
- **Effect obligations.** A run's uncertain effects are listed by
  `GET /v1/runs/:id/obligations`. While any is open, the gate and promotion are
  held. An admin records what was checked with
  `POST /v1/intents/:id/adjudicate {resolution: effect_absent|effect_present_accepted|effect_reverted, note}`
  (audited); held cases then need `POST /v1/runs/:id/retry`.
- **Privacy.** Every captured image masks registered secrets, uninspectable
  content and the policy's `privacy.mask_selectors`; declare selectors for
  regions (e.g. server-rendered images) that can show sensitive data.
- **Qualification.** Grants expire with their live compatibility evidence;
  `qa qualification renew` extends one on a current probe of the same model,
  `qa qualification revoke` ends one immediately.

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
node deploy/demo/run-demo.mjs            # writes docs/evidence/phase10/demo-flow.json (or --out <dir>)
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
   (`RECONCILED` with one order receipt) and the run completes; any effect the
   dead worker left that cannot be verified (an acknowledged but unsettled
   note write, say) holds the gate and promotion until an admin adjudicates it
   and the held cases are rerun, after which the deployment promotes; the dead
   worker's fixtures are swept.

In environments behind a TLS-intercepting proxy, pass the proxy and CA to the
build: `docker build --build-arg HTTPS_PROXY=… --secret id=npm_ca,src=<ca.pem> …`.
