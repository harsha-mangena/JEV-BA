# Target onboarding and deployment acceptance runbook

This runbook covers phases 4 and 5 of the post-PR #5 completion plan. It describes how a real
application is brought under JEV-BA, and how the deployment gate is proven on it.

**Status.** No target application has been supplied, so every step below that needs one is
**BLOCKED**. Nothing target-specific has been implemented or claimed.

Two things exist today:
- the manifest schema and checker (`qa onboarding-check`);
- the platform mechanisms it maps onto.

## 1. Owner inputs

Copy `docs/templates/target-onboarding.yaml` and have the application owner fill it in. Then run:

```bash
npm run qa -- onboarding-check --manifest path/to/target-onboarding.yaml
# exit 0 READY · 3 BLOCKED (each missing input named) · 1 INVALID
```

Each manifest input maps onto an existing platform contract:

| Manifest input | Existing contract it configures | Needed for |
|---|---|---|
| `source` | `ProjectConfig.environments.<env>.lineage`, and the provider in `qa bootstrap` | candidate provenance and lineage |
| `candidate` | `ProjectConfig.environments.<env>.url_patterns` and `ProjectConfig.version_check` | proving which deployment the browser tested |
| `journeys` | `specs/scenarios/*.yaml`, loaded with `loadValidatedScenario`. `expectations_approved_by` must name the owner. | independent pass/fail requirements |
| `identities` | `ProjectConfig.fixture_api` (the token is read from an environment variable) and the fixture catalog (`specs/fixtures.yaml`) | isolated sessions and repeatable state |
| `mutations` | policy mutation bindings and the application adapter's effect lookup (`packages/oracles/src/adapter.ts`) | authorizing and reconciling actions |
| `backend_oracles` | scenario assertions of backend kind, served by the fixture service | verifying persisted business outcomes |
| `cleanup` | fixture cleanup and `cleanup_tasks` obligations | recovering disposable data |
| `profiles` | `ProjectConfig.suite.profiles` and visual checkpoints | defining the qualification scope |
| `artifacts` | `ProjectConfig.retention` and the model-sharing policy | controlling evidence publication |
| `promotion` | `POST /v1/promotions` and `POST /v1/promotions/:id/consume` | enforcing release decisions |

**Rules.**
- Never fill a field from the application's current behaviour. An expected value that the owner
  has not approved is not a requirement.
- An inaccessible oracle or an unsupported interaction is `BLOCKED` or `NEEDS_REVIEW`, never
  `PASS`.
- Screenshots:
  - With `model_sharing: none` or `text_only`, no image leaves the runner.
  - Firefox and WebKit profiles withhold every screenshot. See `deploy/README.md` under
    "Privacy".

## 2. Deterministic target acceptance (phase 4)

Everything in this section is **BLOCKED** until the manifest is READY and a disposable, authorized
target environment exists.

**Setup and clean runs.**
1. Run `qa bootstrap` with the project configuration built from the manifest. Then run
   `qa doctor --role api` and `qa doctor --role worker`.
2. Run `qa run --base-url <candidate> --environment <env> --commit-sha <sha>`. Every critical
   journey must pass, and every backend oracle must observe the persisted effect. A success banner
   on its own does not count.
3. Seeded defects must be supplied by the owner, for example a defective candidate deployment. Each
   one must fail on the correct oracle.

**Fault cases.** Each must be shown on the target:

| Fault | Required outcome |
|---|---|
| Response lost after a mutation | The effect is reconciled; the intent is not replayed |
| Worker dies after dispatch | The intent is reconciled; the effect is not duplicated |
| Unresolved effect | `NEEDS_REVIEW`; the gate holds whether or not the case is critical |
| Ordinary assertion retry | Follows the declared retry policy |
| Fixture failure | The run is recorded as `BLOCKED` or `ERROR` |
| Cleanup failure | A cleanup obligation is recorded |
| Concurrent runs | Runs are isolated; admission is atomic |

On the fixture, `tests/service/durability.test.ts`, `tests/service/obligations.test.ts` and
`tests/e2e/retry-obligations.test.ts` show these behaviours. They do not show them on a target.

## 3. Deployment-triggered acceptance (phase 5)

Everything in this section is **BLOCKED** until the target, provider access and the owner's
promotion controller are available.

**Installation.**
- **Trigger:** use a provider *ready* event, not a push. For GitHub, use a deployment-status
  webhook to `/v1/webhooks/github`. For Vercel, use `docs/templates/vercel-repository-dispatch.yml`.
  For a pipeline, run `qa submit` after the deploy job.
- **Required check:** set `required_check: true`, and make it required in the target repository's
  branch or environment protection.
- **Consumer:** the owner's release controller calls `qa promote`, or the promotions API. It
  promotes only the `deployment_id`, `commit_sha`, `channel` and `generation` that the consume
  response returns. A status badge alone enforces nothing.

**Acceptance cases.** Each must be observed on the installation:

| Case | Required observed outcome |
|---|---|
| Clean current candidate | The selected required suite runs, and the consumer promotes the bound candidate exactly once |
| Seeded critical defect | The correct oracle fails, and promotion is refused |
| Missing, timed-out or cancelled QA | Promotion is held |
| A new candidate arrives during an old run | The old eligibility cannot promote the new or a superseded deployment |
| Same source SHA, different deployment or configuration | A distinct execution identity is created, and reuse is refused |
| Duplicate or out-of-order event | It is handled idempotently, with no duplicate logical effects |
| Worker dies after a mutation | The effect is reconciled, and the uncertainty holds promotion |
| Open non-critical effect obligation | The gate stays held |
| Policy, profile or baseline change | The old eligibility is invalidated |
| Expired or replayed promotion request | It is refused and audited |

**Race safety.** If the provider cannot promote conditionally on the candidate identity, the
consumer must be serialized or fenced, and it must revalidate immediately before promoting. Any
remaining race must be documented, not described as atomic.

On the fixture, the service lane (`tests/service/lineage.test.ts`, `tests/service/promotion.test.ts`)
and the Docker demo (`deploy/demo/run-demo.mjs`) cover this. That is regression evidence for the
mechanism, not proof of an installation.

## 4. Recording the results

For each target run, record:
- revision, dirty state, command and environment;
- dependency identities and the configuration digest;
- start and end times, and the first-run result;
- counts;
- external prerequisites;
- sanitized evidence checksums.

Secret values are never recorded. Record the results in the completion ledger
(`docs/completion-ledger.md`), then move the inventory items `TARGET-ONBOARD` and `TARGET-DEPLOY`
off `BLOCKED` only with that evidence.
