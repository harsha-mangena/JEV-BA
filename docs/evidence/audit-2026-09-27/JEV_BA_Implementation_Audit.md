# JEV-BA implementation audit

**Verdict: substantial implementation exists, but the ten-phase plan is not complete and this revision is not ready to serve as a trusted autonomous release gate.**

Reviewed September 27, 2026. Repository: [harsha-mangena/JEV-BA](https://github.com/harsha-mangena/JEV-BA). The supplied URL did not specify a branch. I audited `main` at `cb83f85b94be7080d577580d2038d44a9cbc9074`. It merges Claude's `claude/new-session-lnwzm0` branch; that branch's tip, `18c2251b0306e6213806daa697cab7cb3956c28e`, has the same file tree. Findings therefore apply to both reviewed trees.

The reference was the previously agreed System One implementation plan, also present as `docs/implementation-plan.md`. This review distinguishes implementation, executable evidence, missing integrations, and operational configuration. It does not infer completion from package names or README checkmarks.

## 1. Tests actually performed

| Validation | Result | Evidence boundary |
| --- | --- | --- |
| Dependency installation | Passed | `npm ci --ignore-scripts`; repository dependency versions preserved |
| TypeScript | Passed | `npm run typecheck` on the original production tree |
| Existing unit tests | **108 passed**, 11 files | Executed locally |
| Scenario validation | **9 validated** | Executed with `node --import tsx apps/cli/src/main.ts validate` |
| Existing browser E2E suite | **60 passed**, 7 files | Real Chromium, controlled fixture app; includes clean journeys, deliberately broken applications, exploration, quality checks and compiler/repair flows |
| Existing service tests locally | **24 skipped**, 2 files | No PostgreSQL service available in this execution environment |
| Exact-commit GitHub CI | **108 unit + 84 E2E/service passed** | I read the existing job's logs; its PostgreSQL-backed service tests comprise 14 orchestration and 10 platform tests. This is independent CI evidence, not a claim that I reran PostgreSQL locally. |
| New independent audit suite | **13 failed safety assertions**, 1 file | Eight issue groups; browser runs, provider contract tests, a real local HTTP server, a generated Playwright child process, and one explicit database-read double |
| Live provider smoke suite | **1 skipped** | No configured live TypeSafe endpoint credentials; no live Jev inference result is claimed |

GitHub evidence: [CI run 36350121071](https://github.com/harsha-mangena/JEV-BA/actions/runs/36350121071), job `108707054374`, exact reviewed commit. Its E2E step completed successfully with 84 passing tests. These tests still use local provider doubles; successful CI does not prove live vendor compatibility.

Local runtime was Node 24.19.0, npm 11.9.0, Playwright 1.56.1 and downloaded Chromium 141.0.7390.37. The repository pins Node 22 for CI and permits Node >=22. The `tsx` launcher could not open its Unix IPC socket here; the equivalent Node import invocation validated the scenarios successfully. An initial browser run preceded browser installation and failed setup; the final reported browser run occurred after installation and passed. Neither environment issue is counted as a product defect.

The audit suite's assertions encode the behavior the design requires. They are not marked `todo` or expected-failure: their failures expose the current implementation's behavior. No production implementation was edited and no changes were pushed.

## 2. Reproduced findings

P1 means fix before using the affected capability as a trusted service or release-control boundary. P2 means a material missing capability or reliability defect. The eight groups below have executable reproductions in the accompanying test bundle.

| ID | Priority | Finding | Observed result |
| --- | --- | --- | --- |
| F01 | P1 | TypeSafe/Jev adapter does not implement the published API contract | Questions encoded as an array; official Noul response rejected |
| F02 | P1 | Mutation authorization can be bypassed | Real checkout created an order with `mutations: []`; regression reported PASS and an eligible gate |
| F03 | P1 | Generated-spec execution is not a filesystem sandbox | A spec passed lint and validation while writing a harmless marker outside its working directory |
| F04 | P1 | Calibration and model identity are not enforced as an autonomy boundary | Mismatched calibration produced ACT; a different resolved model was recorded as calibrated and completed checkout |
| F05 | P1 | Required execution-profile changes do not invalidate old gate results | Required cases increased from 9 to 12 without changing suite hash; promotion gate still returned eligible |
| F06 | P1 | Trace artifacts retain fixture session credentials | `trace.network` contained the synthetic session value from a successful authenticated checkout |
| F07 | P2 | S2 vision escalation is incomplete | Image-capable S2 was called without a screenshot; no concrete live S2 provider is wired into the service |
| F08 | P2 | Caller cancellation disables the provider request timeout | A 20 ms timeout did not abort a local response delayed by 250 ms |

### F01 — Fix the TypeSafe wire contract before claiming Jev integration

Source: [providers.ts, encoder](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/s1/src/providers.ts#L133) and [decoder](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/s1/src/providers.ts#L163).

The current [official API reference](https://docs.typesafe.ai/api) requires a question-ID map, `instructions`, and a `criteria` map for Choice questions. The repository emits an array containing `id`, `question`, and `options`. Its decoder also omits the documented `noul` response field. This is a documented-contract mismatch established without consuming a paid API call; an actual live 422 response was not observed in this review.

**Reproductions F01a/F01b:** the request is an array and an official-shaped `{type: "noul", noul: 0.95}` answer produces `invalid noul probability`. The README acknowledges unverified format, but the adapter's `WIRE_FORMAT_VERIFIED=false` marker does not prevent service configuration from selecting it.

**Required correction:** map the neutral internal request to the documented wire schema, decode the official fields, add recorded official-format contract fixtures and a real authenticated smoke test, then test at least one complete Jev-driven fixture journey and one seeded failure. Keep stable option keys separate from descriptions. Do not relabel a heuristic/offline provider test as live Jev validation.

### F02 — Enforce mutation permission independently of optional step annotations

Sources: [authorizeIntent](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/contracts/src/policy.ts#L83), [regression dispatch](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/worker/src/regression.ts#L22), and [autonomous gate](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/gate/src/gate.ts#L142).

**F02a:** clone the approved checkout, remove step/milestone intent annotations, and set `policy.mutations=[]`. Semantic validation returns no issues. The browser still clicks the already-known `Place order` control, the backend oracle confirms exactly one new order, and the runner returns PASS with `gate.eligible=true`.

**F02b:** remove the trusted binding for `Place order`, set the exploration scenario to `unknown_actions: read_only_exploration`, and authorize no mutations. The offline S1 controller completes checkout and the backend independently verifies order creation. An origin allow-list does not restrict same-origin writes.

The default `unknown_actions: deny` path and explicitly annotated forbidden-mutation tests do work. These findings concern missing annotations and the opt-in read-only exploration path; they do not imply that every default scenario ignores permissions.

**Required correction:** reconcile observed controls with trusted route/control semantics in both drivers; reject missing, conflicting and unrecognized mutation intents. Treat unknown effect as insufficient authorization to dispatch. Make read-only capability enforceable through application-specific effect restrictions and disposable credentials; HTTP verb filtering alone is insufficient for arbitrary applications. Add both negative reproductions to mandatory CI.

### F03 — A child process with a fresh directory is not an execution sandbox

Sources: [lintGeneratedSpec](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/compiler/src/playwright.ts#L116) and [validateGeneratedSpec](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/compiler/src/validate-spec.ts#L18).

**F03:** a generated spec imports `writeFileSync` from plain `fs`, writes an audit-owned marker outside the generated-test directory, and contains an ordinary passing Playwright assertion. Lint returns `[]`; validation returns `passed`; the marker exists. The marker is removed by test cleanup. No unrelated file or credential was accessed.

The regex blocks `node:fs` but not equivalent imports, and the child inherits the host user's filesystem/network authority. Minimal environment variables and a timeout are useful controls, but do not provide isolation. This is not proof of an unauthenticated remote-code-execution endpoint; it is a confirmed missing boundary wherever generated or supplied code reaches this validator.

**Required correction:** prefer executing a constrained, validated action representation. If source execution remains, use an actual isolated process/container boundary with restricted mounts, credentials and egress; validate imports using syntax-aware allow-lists as defense in depth. The compiler's existing semantic-preservation tests should remain in place.

### F04 — Bind calibration to the model that actually answered

Sources: [gate uncertainty routing](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/gate/src/gate.ts#L193), [calibration attachment](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/calibration/src/registry.ts#L159), [decision configuration](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/worker/src/exploration.ts#L68).

Three different reproductions establish the gap:

- **F04a:** an exact-config mismatch returns ACT with `calibration_config_mismatch`. When the gate had `heuristic=false`, there is no heuristic warning on that fallback.
- **F04b:** loading a calibration whose threshold is null falls back to the ordinary heuristic gate and still returns ACT. There is no distinct advisory-only enforcement mode for this outcome.
- **F04c:** request model A, return model B, and supply a scorer bound to A's requested configuration. Real browser checkout passes; all three decisions record model B together with `calibrated:cal_model_a` and ACT.

The last reproduction is especially important: logging both IDs does not enforce identity. The digest uses the requested model, while the returned resolved model is only evidence. A model alias or changed backend could therefore use an inapplicable calibration.

**Required correction:** resolve/pin the actual model identity; reject drift before browser dispatch or route into an explicitly uncalibrated, separately permitted mode. Include provider and actual model identity in calibration compatibility. Distinguish shadow, heuristic disposable-staging exploration and calibrated autonomy in policy. Do not silently fall back from a failed calibration qualification. Existing exploration is advisory to the release aggregate, which limits release impact but does not prevent its browser mutations.

### F05 — Gate validity must include the effective execution configuration

Sources: [suite revision](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/orchestrator/src/suite.ts#L25) and [gateStatus](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/orchestrator/src/service.ts#L275).

**F05:** change the required profiles from desktop-only to desktop-plus-mobile. Selection expands from 9 to 12 required cases, but both suites have revision `suite_784effa252f697d4` in this checkout. The hash includes scenario, policy, catalog and optional coverage files; it omits the effective profile configuration.

**F05b:** invoke the real `gateStatus` method with the changed project and an old completed desktop-only run. It returns `{eligible: true, run_id: "old-desktop-run", reasons: []}`. This second probe uses an explicitly identified read-only database double to supply stored rows; the production gate method and suite loader run unchanged. It is not a PostgreSQL integration test.

Logical run deduplication does include a profile-set field, so a newly submitted event can create a new run. The defect is that changing configuration does not itself make an existing gate ineligible.

**Required correction:** persist and compare a canonical execution-configuration digest including effective profiles, capability policy, applicable oracles/baselines and runtime versions. Recompute the required manifest at promotion or verify its versioned identity. An old run must not satisfy newly added requirements simply because YAML files are unchanged.

### F06 — Sanitize the trace archive, not just event/report text

Sources: [trace capture](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/worker/src/session.ts#L130) and [artifact writing](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/evidence/src/log.ts#L52).

**F06:** run successful authenticated checkout, retain its disposable fixture credentials in memory, and scan the resulting ZIP entries. `trace.network` contains a session credential. No credential value is printed or included in the audit bundle.

The repository registers session values with its text redactor, but disables trace capture only for scenarios that explicitly type secret references. Authenticated scenarios that start with cookies still produce raw traces. The existing secret-leak test scans JSON/JSONL/XML/HTML files and never inspects ZIP contents.

**Required correction:** sanitize trace network records and sensitive snapshots before publication, or withhold raw authenticated traces and produce a sanitized evidence format. Add archive-content tests with synthetic credentials, including cookies, authorization headers and controlled sensitive response content. Continue restricting artifact access and retention. This reproduction concerns synthetic credentials in local test artifacts, not an observed disclosure of a real user's secret.

### F07 — S2 interfaces exist, but the vision/context loop is unfinished

Sources: [S2 interface](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/s2/src/index.ts), [escalation dispatch](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/worker/src/exploration.ts#L151), [service configuration](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/cli/src/service.ts), and [visual-review interface](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/quality/src/review.ts).

**F07:** force ambiguous S1 scores and inject an S2 provider advertising `supportsImages=true`. S2 is invoked, but `screenshot_png` is absent. The repository contains typed proposal validation and injected test providers, not a concrete configured live S2 client. The service's `explorationFromEnv` supplies S1/model/gate only. The visual reviewer is also an interface rather than a deployed model adapter.

`REQUEST_CONTEXT` and `PROPOSE_SUBGOAL` are both reduced to a reobserve decision followed by a 300 ms wait. Requested screenshots, larger candidate lists and scroll-region context are not actually acquired, and proposed subgoals are not adopted.

**Required correction:** implement and configure the selected vision provider, image capture/redaction, useful request context, cancellation and deadlines. Implement each supported context request explicitly; reject unsupported requests rather than pretending a wait fulfills them. Keep typed proposals and re-entry through policy/freshness checks.

### F08 — Combine request timeout with caller cancellation

Sources: [neutral HTTP provider](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/s1/src/providers.ts#L102) and [TypeSafe HTTP provider](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/s1/src/providers.ts#L178).

**F08:** a real local HTTP endpoint delays its response 250 ms. Configure a 20 ms timeout and pass an un-aborted cancellation signal, as the job worker does. The request completes successfully after approximately 274 ms instead of timing out.

Both providers use `signal ?? AbortSignal.timeout(...)`, which replaces the timeout when a caller signal is present. Scenario deadlines are checked between calls, not enforced during the awaited fetch. S2 calls also omit the cancellation signal.

**Required correction:** combine caller cancellation, per-request timeout and the scenario's remaining deadline. Stop retries immediately after cancellation and propagate the same bounded behavior through S2 and backoff. Verify with a delayed endpoint and an endpoint that never sends a body.

## 3. Additional implementation gaps identified by inspection

These are code-backed gaps, but are not included in the 13 dynamically reproduced failures.

**F09 — P1: the action-intent ledger is not durable before dispatch.** `EvidenceLog.record()` queues asynchronous append operations and returns immediately. Both drivers label an intent `persisted` and dispatch without awaiting a durable commit. The database migrations do not contain the planned action-intent ledger, and shared artifact upload happens after suite completion. See [event log](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/evidence/src/log.ts#L37), [regression](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/apps/worker/src/regression.ts#L45) and [worker](https://github.com/harsha-mangena/JEV-BA/blob/cb83f85b94be7080d577580d2038d44a9cbc9074/packages/orchestrator/src/worker.ts).

The existing worker-loss test expires a lease after provisioning a viewer fixture; it does not crash after an order submission. Fresh fixtures on retry reduce duplicate effects on the same entity, but do not demonstrate the planned recovery of an uncertain mutation. Add a shared durable intent/effect record, appropriate application idempotency keys or read-back reconciliation, and crash tests immediately before dispatch and after acceptance/before acknowledgment. Do not claim exactly-once external effects from a worker lease alone.

**F10 — P2: action/candidate capabilities are narrower than the initial architecture.** Autonomous execution enables CLICK/TYPE/WAIT/DONE/BLOCKED only. SELECT/SCROLL are explicitly disabled; scroll, upload, drag/canvas, iframe and shadow-DOM support are excluded in the capability matrix. This scope is documented, which is good, but it prevents general end-to-end autonomous testing of applications that require those controls. Reobserve currently does not recover an omitted off-screen candidate by scrolling. Implement the required capabilities or explicitly narrow the product's supported-app contract and phase acceptance criteria.

Further tests are needed for concurrent tenant job limits and lease loss during active execution. In `JobWorker.lease`, active counts are read while only the selected job row is locked; simultaneous workers can evaluate the same tenant count against different jobs. The existing fairness test leases sequentially. This is a concurrency risk identified by inspection, not a locally reproduced PostgreSQL race. Add a synchronized multi-connection stress test and a tenant-level atomic admission mechanism if it confirms the race.

## 4. Phase-by-phase assessment

| Phase | Assessment | What is present | What prevents complete sign-off |
| --- | --- | --- | --- |
| 0 — Contracts and fixture | Substantially implemented | Strict schemas, fixtures, requirement IDs, seeded-defect app, approved scenarios | Mutation semantics are not fully enforced when annotations are absent; F02 |
| 1 — Deterministic runner | Implemented core; hardening incomplete | Real Playwright execution, independent backend/UI oracles, explicit non-PASS verdicts, cleanup, retry evidence, HTML/JUnit | Authorization, trace sanitization and durable intent defects; F02/F06/F09 |
| 2 — S1 observation and adapter | Partial | Observation model, node registry, multi-head request, response validation, offline providers | Actual TypeSafe wire contract broken; live smoke skipped; limited control/frame support; F01/F10 |
| 3 — Gate and S2 autonomy | Partial | Ordered permission/freshness checks, uncertainty features, bounded loop, typed S2 proposals | Permission loopholes, no concrete S2 vision integration/context acquisition, calibration drift, timeout/ledger gaps; F02/F04/F07/F08/F09 |
| 4 — Deployment orchestration | Substantial implementation; not ready for unconditional release control | Durable jobs/outbox, signed ingress, trusted metadata adapters, readiness/SHA checks, deduplication and required-case aggregation; CI service tests pass | Required-profile changes can leave an old eligible result; crash-after-submit guarantee not demonstrated; real installation/promotion behavior still needs validation |
| 5 — Visual/a11y/UX | Core checks implemented; vision integration partial | Explicit baseline approval, pixel/geometry checks, axe, keyboard tests, evidence-based UX hypotheses | Live vision review adapter absent; image/context path incomplete; only Chromium exercised here |
| 6 — Change impact and proposals | Substantial fixture-level implementation | Requirement graph, broad fallback selection, coverage learning and proposal validation | Needs target-application mapping and measured selection recall/false-pass rate; do not equate fixture success with broad app coverage |
| 7 — Compilation and repairs | Core behavior implemented; isolation incomplete | Verified-journey compilation, export, seeded-bug preservation, repair classification | Generated source is not truly sandboxed; F03 |
| 8 — Calibration and evaluation | Tooling implemented; operational qualification incomplete | Grouped splits, fitted scorer, bounds, cohort reports and canary tooling | No representative labeled dataset or measured Jev qualification; incompatible resolved models can still be marked calibrated; F04 |
| 9 — Production service | Partial | Scoped roles, onboarding endpoints, artifact stores, quotas, sweepers, dashboard and provider adapters | Isolation/redaction/timeout/lease risks, no real deployment-provider acceptance or multi-worker load proof; fixture-specific integrations remain |

The README's blanket “Done” labels overstate acceptance. A more accurate status vocabulary would be **implemented and verified**, **implemented with fixture tests**, **integration pending**, and **blocked by finding**.

## 5. Can new deployments trigger this suite?

**Yes, the triggering machinery exists. It is not automatically connected to your application's deployments merely by cloning this repository.**

Implemented paths include a signed GitHub webhook, Vercel adapter, and authenticated pipeline/manual deployment submission. The service verifies deployment identity and readiness, queues browser work and publishes status. A promotion controller can query `GET /v1/gate` with the deployment ID and SHA. Local doubles exercise the provider interfaces; GitHub CI confirms the PostgreSQL-backed service paths pass their existing tests.

Only `.github/workflows/ci.yml` is installed as a workflow in this repository, running on push/PR. Deployment-workflow examples are under `docs/templates/`; they are templates, not active application integrations. A direct webhook integration does not require copying a workflow, but it does require running/configuring the API and worker.

For your application, the remaining setup is to provision the service/database/artifact store, configure project/environment/immutable URL/SHA identity, connect a webhook or deployment job, and implement your own fixture/auth/cleanup/backend-oracle integrations. The supplied client is tailored to the controlled shop's `/__qa` endpoints and entities. The model does not automatically provide independent business correctness expectations for a new application.

For safe rollout, first run the approved regression suite on disposable preview/staging deployments in advisory mode. Fix F02/F05/F06/F09 before trusting the affected release-control and evidence guarantees. Enable Jev exploration after F01 and the provider qualification checks. Add S2 after F07; enforce F04/F08 before expanding autonomy. Verify the actual promotion controller holds on failure, missing results, stale configurations and cancelled runs. This audit did not deploy the service, configure webhooks, modify branch protection or publish GitHub comments.

## 6. Remediation sequence and acceptance

1. **Close the demonstrated boundaries.** Address mutation authorization, generated-code containment, artifact sanitization, and profile/config invalidation. Keep all related reproductions in required CI. Acceptance: unauthorized checkout never dispatches, an old desktop-only run cannot approve newly required mobile coverage, generated source cannot access the host outside allowed mounts, and trace scans find no synthetic credentials.
2. **Make the real model path work.** Correct TypeSafe request/response mapping, combine deadlines/signals, pin and verify resolved model identity, and add concrete S2 image/context handling. Acceptance: authenticated provider contract tests pass; a complete allowed fixture journey succeeds; deliberately broken checkout remains non-PASS; cancellation and ambiguity terminate within budgets.
3. **Prove recovery and service concurrency.** Persist intents before effects and reconcile unknown outcomes; test worker termination after a real mutation and simultaneous leases under quota. Acceptance: no repeated uncertain effect, no falsely green missing shard, cleanup remains durable, and tenant limits hold under concurrent admissions.
4. **Integrate the target application.** Add business requirements, fixtures, role/session handling, backend oracles, cleanup and deployment metadata. Exercise clean and deliberately broken previews through the real CI/CD provider and actual promotion controller.
5. **Qualify broader autonomy.** Gather representative labels, measure supported cohorts and end-to-end defect detection, compare against deterministic reference runs, install and test additional browser profiles, and expand control/frame capabilities as required. Publish measured coverage and limitations instead of claiming universal UI/UX testing.

## 7. Reproduction bundle

`JEV_BA_Audit_Evidence.zip` contains `audit/review.test.ts`, `audit/vitest.config.ts`, a reproduction README, original local test logs, and an exact-commit CI evidence summary transcribed from the retrieved job log. It excludes raw browser traces, credentials, node_modules and the repository checkout.

To reproduce against the reviewed commit, copy the bundle's `audit/` directory into the repository root after checking out `cb83f85b94be7080d577580d2038d44a9cbc9074`, install dependencies and Chromium, and run:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:e2e
npx vitest run --config audit/vitest.config.ts
```

The last command should currently fail 13 assertions. The trace-content check also requires Python 3. Supplying a disposable PostgreSQL `DATABASE_URL` enables the original service tests; without it, those 24 tests are intentionally skipped. Live S1 checks require the separately configured provider endpoint, model and credentials.

The API contract was verified against the [official TypeSafe reference](https://docs.typesafe.ai/api) during this audit. All repository links above are pinned to the reviewed commit. These findings establish concrete blockers, not an exhaustive security certification or a measurement of Jev's real-world accuracy.
