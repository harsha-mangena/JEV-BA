# Operations runbook

## Components

| Process | Command | Scales | State |
| --- | --- | --- | --- |
| API | `qa serve-api` | horizontally | stateless (Postgres) |
| Worker | `qa serve-worker` | horizontally; leases are fair across tenants and capped per tenant | stateless (Postgres + artifact store); needs a browser |
| Postgres | — | primary + replicas | runs, jobs, outbox, audit, findings, approvals |
| Artifact store | filesystem or S3-compatible | — | evidence, traces, screenshots, baselines |

Workers run the pinned Playwright/Chromium build (`@playwright/test` 1.56.1).
Use one container image for all workers so fonts and rendering match the
baselines' rendering profile.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection |
| `QA_SUITE_BASE_DIR` | Directory project suite paths resolve against (a checkout of the specs repo) |
| `QA_ARTIFACT_DIR` or `QA_S3_BUCKET` (+ `QA_S3_ENDPOINT`, `QA_S3_REGION`, `QA_S3_PREFIX`, `QA_S3_PATH_STYLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) | Evidence and baselines |
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY(_FILE)` or `GITHUB_TOKEN`; `GITHUB_API_URL` | Deployment lookup, commit statuses, compare |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Vercel deployments and checks |
| `QA_REPO_DIR` | Optional local clone for git-based impact analysis |
| `<project fixture_api.token_env>` | Fixture-service token per project (referenced, never stored) |
| `<project webhook_secret_ref>` | Webhook secret per project |
| `QA_S1_PROVIDER` (`typesafe`/`http`), `QA_S1_ENDPOINT`, `QA_S1_MODEL`, `QA_S1_API_KEY` | Enables exploration shards |
| `QA_CALIBRATION_DIR` | Calibration registry used by the gate |

## Onboarding a project

1. `qa bootstrap --tenant <t> --project <p> --config project.yaml --token admin:root` (or `POST /v1/projects` with a tenant admin token).
2. Mint tokens: `POST /v1/tokens {role: submitter|reviewer|viewer, label, project_id}`. Tokens are shown once.
3. Install the GitHub App on the repository (or configure the webhook) and mark
   `autonomous-qa/<project>/<environment>/required` as a required status.
4. For Vercel, point the deployment webhook at `/v1/webhooks/vercel/<project>`
   with the project's webhook secret, or use `docs/templates/vercel-repository-dispatch.yml`.
5. First runs in each environment select the full suite and create visual
   candidates; reviewers approve baselines from the dashboard.

## Enabling autonomy (S1 exploration)

1. `qa s1 probe` must report no invalid heads for the pinned model.
2. Run exploration in advisory mode (default; never gates) and collect runs.
3. `qa evals extract`, label, `qa calibrate --target <precision>`.
4. Set `QA_CALIBRATION_DIR`. The gate acts only for the exact decision
   configuration and supported cohorts; everything else escalates or abstains.
5. On any model/prompt/extractor/policy change, run `qa evals canary`.

## Alerts and housekeeping

- Cleanup failures: the sweeper retries with backoff and writes
  `cleanup.alert` to the audit log (and the worker log) after 3 failures.
- Outbox: failed status publications retry with jittered backoff; watch
  `outbox_events where published_at is null and attempts > 5`.
- Jobs: `jobs where state='failed'` are permanent failures; their runs are
  `ERROR` (or report missing shards).
- Retention: artifacts older than `retention.artifacts_days` are purged by the
  worker's sweeper; run rows, gate results and audit remain.
- Quotas: `tenants.max_concurrent_jobs`, `tenants.s1_daily_quota`.

## Backups and recovery

Back up Postgres (point-in-time) and the artifact bucket (versioning on).
Workers are disposable: an expired lease is re-leased; fixtures from a lost
attempt are cleaned by the sweeper; uncertain mutations are never retried
blindly — a new attempt uses a fresh fixture.
