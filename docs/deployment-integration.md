# Deployment-triggered QA (Phase 4)

```
provider event ─► POST /v1/deployment-events | POST /v1/webhooks/github
   │  authenticate (bearer token role=submitter, or HMAC X-Hub-Signature-256)
   │  dedup delivery (provider, delivery id) → redelivery returns the same run
   │  verify claim against trusted provider metadata (GitHub deployment + statuses)
   │  URL policy: environment pattern, origin only, no credentials, public IPs only
   │  load suite → suite revision (hash of specs/policy/catalog) → selection manifest
   │  logical run dedup key (tenant, project, provider, deployment, suite revision, profiles)
   │  supersede older unfinished runs in the same environment
   ▼
runs(WAITING_READY) ─ jobs: readiness ─► QUEUED ─ execute_shard × N ─► RUNNING ─ aggregate ─► COMPLETED
                                                                  outbox: publish_status (every transition)
```

- **Readiness** requires the target to report exactly the verified SHA (`version_check`:
  JSON field or `<meta>`), without redirects. A generic HTTP 200 is not enough.
  Mismatch → `ERROR version_drift`; unreachable → `ERROR not_ready`.
- **Shards** run the Phase 1 runner with a fresh fixture per case, the same
  revision check before and after, and durable cleanup obligations
  (`cleanup_tasks`). A shard that exhausts its attempts is recorded as failed;
  aggregation then reports its cases as *missing results* and the gate holds.
- **Status** is published on the exact deployment SHA with context
  `autonomous-qa/<project>/<environment>/required`. The outbox re-reads the run
  when publishing, so a superseded or cancelled run can never publish success.
- **Promotion** consumes `GET /v1/gate?project_id&environment&deployment_id&commit_sha`:
  eligible only for the environment's *current* candidate, the same SHA, an
  unchanged suite revision, and a completed run with an eligible gate.
- **Cancellation** stops queued work immediately; an executing shard aborts at
  its next checkpoint and still cleans up. **Retry** requires a reason, creates
  a new attempt of the same logical run, preserves earlier attempts' results,
  and is refused for a deployment that is no longer current.

## Trigger options

| Arrangement | Use |
| --- | --- |
| Deploy job in the same pipeline | `qa submit --provider pipeline …` then `qa wait` in a dependent job |
| Provider creates GitHub deployments | GitHub webhook to `/v1/webhooks/github` (works even for `GITHUB_TOKEN`-created statuses), or `docs/templates/submit-deployment-qa.yml` |
| External release controller | `POST /v1/deployment-events` with `provider: manual` |

For pipeline/manual submissions the authenticated submitter is the provenance
and the readiness revision check binds URL to SHA before anything runs.

## Running the service

```bash
export DATABASE_URL=postgres://…  QA_SUITE_BASE_DIR=/path/to/qa-repo
export GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=…   # or GITHUB_TOKEN
npm run qa -- migrate
npm run qa -- bootstrap --tenant acme --project shop --config project.yaml \
  --repository-id 4242 --repository acme/shop --webhook-secret-env SHOP_WEBHOOK_SECRET \
  --installation-id 123 --token submitter:ci --token viewer:dash
npm run qa -- serve-api --port 8080
npm run qa -- serve-worker
```

`project.yaml` follows `ProjectConfig` in `packages/contracts/src/project.ts`.
Secrets (fixture tokens, webhook secrets) are referenced by environment
variable name and never stored in the database.
