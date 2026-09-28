# JEV-BA completion — closure report

Branch `claude/new-session-lnwzm0`. Lane evidence was produced on commit
`3c3dd97` with a clean tree (`dirty: false` in every manifest); the unattended
deployment flow ran on an image built from the same code. This report is
committed after that evidence and changes documentation only.

**Bottom line.** All 13 audit probes now pass. The offline lanes (static, unit,
e2e, service, audit, isolation) pass with nothing skipped, and the unattended
deployment flow passes on the built image. Eight findings plus the concurrency
risk are `IMPLEMENTED_OFFLINE_VERIFIED`. Two findings need live provider
credentials (`LIVE_VERIFICATION_REQUIRED`): F01 (TypeSafe/Jev) and F07 (vision
S2). Calibrated autonomy is `BLOCKED` for every profile, because there is no
representative labelled data and no live provider record. So the platform is
**not** complete for a production autonomy profile. What is complete and
verified is the fixture-shop offline profile, in which workers run exploration
in shadow mode.

## 1. Finding closure

| Finding | State | What changed | Verified by |
|---|---|---|---|
| **F01** TypeSafe contract | LIVE_VERIFICATION_REQUIRED | The request is `{state, model, questions:{key:{type, instructions, criteria}}}`, and choice criteria map option keys to descriptions. Choice answers decode as `{choice, probabilities, confidence}` and noul answers as `{noul}`. A mismatched answer type becomes an invalid head. The official endpoint and model `jev-latest` are the defaults. Provenance is recorded in `TYPESAFE_CONTRACT`: it comes from the public Go client, because the API reference host is unreachable from the build environment. | Audit F01a/F01b; `packages/s1/test/providers.test.ts`; live lane BLOCKED (`QA_S1_API_KEY`) |
| **F02** mutation bypass | IMPLEMENTED_OFFLINE_VERIFIED | One `authorizeAction` service is used by regression steps, exploration (gate and dispatch), S2 selections, start navigation and reload assertions. It is driven by a trusted application contract: intents with effect kinds, routes, and control bindings scoped by route, form and section, with operations, roles and accepted parameters. Unknown effects are always denied; the `read_only_exploration` opt-out no longer grants anything. Steps are prepared without input, authorized, and then dispatched exactly once. | Audit F02a/F02b; `tests/e2e/authorization.test.ts` (backend write journal and adapter entity oracle); `packages/contracts/test/authorize.test.ts` |
| **F03** generated-code isolation | IMPLEMENTED_OFFLINE_VERIFIED | Generated code runs only in the namespace sandbox: an unprivileged user in user/mount/net/pid/ipc/uts namespaces, `pivot_root` onto a tmpfs root with read-only binds, and the work directory as the only writable host path. Networking is loopback-only, with a relay to the application under test. The process has zero capabilities, `no_new_privs`, rlimits, and a process-group kill on timeout. There is no host fallback. A TypeScript AST allow-list lint runs first. | Audit F03; `tests/isolation/sandbox.test.ts` (8 host-side escape checks); `packages/compiler/test/lint.test.ts`; `tests/e2e/compiler.test.ts` (compiled Chromium spec passes inside the sandbox) |
| **F04** autonomy/calibration identity | IMPLEMENTED_OFFLINE_VERIFIED | There are three modes: shadow, heuristic_staging and calibrated. Any configuration that claims calibration is treated as calibrated. In that mode a digest mismatch, an unqualified calibration or an unknown resolved model routes the decision and never acts. The digest binds the resolved model. Heuristic and S2 actions are refused in production and in calibrated mode. The service defaults to shadow, and calibrated mode also requires a qualified profile (phase 11). | Audit F04a/F04b/F04c; `packages/gate/test/gate.test.ts`; `tests/service/promotion.test.ts` (qualification downgrade) |
| **F05** execution identity/promotion | IMPLEMENTED_OFFLINE_VERIFIED | The suite revision is now the digest of an execution snapshot: specs, contract version, required profiles, scenario filter, retries and engine version. Each run stores its snapshot and a monotonic generation. Promotion decisions are single-use, bound to the run attempt, revision and generation, re-checked when consumed, and expire. A reused delivery id with a different payload is rejected. Outbox publishing is serialized per run. | Audit F05/F05b; `tests/service/promotion.test.ts`; demo flow steps 1 and 2 |
| **F06** credentials in archives | IMPLEMENTED_OFFLINE_VERIFIED | Trace ZIPs are rewritten before registration. Credential headers and cookies are blanked, and registered secrets are removed in plain, URL, base64 and JSON-escaped forms. The result is re-scanned; an unreadable archive or any residual hit is withheld. Every written artifact passes the same checks, and screenshots mask password inputs. | Audit F06; `packages/evidence/test/sanitize.test.ts` |
| **F07** vision S2 and context | LIVE_VERIFICATION_REQUIRED | `AnthropicVisionS2Provider` uses the Claude Messages API with structured output, a masked screenshot, and page state delimited as untrusted data. A refusal becomes ABSTAIN. Requested context (screenshot, full candidate list, scroll, wait) is actually fulfilled. Subgoals and S2 calls are bounded. | Audit F07; `tests/e2e/capabilities.test.ts`; `packages/s2/test/anthropic.test.ts`; live_s2 lane BLOCKED (`ANTHROPIC_API_KEY`) |
| **F08** deadlines/cancellation | IMPLEMENTED_OFFLINE_VERIFIED | The bounded transport combines the caller's signal with its own per-attempt timeout (`AbortSignal.any`). It caps request and response sizes and retries only network errors, 408, 429 and 5xx, with jitter and `Retry-After`. It stops at once on cancellation. Each attempt has one signal combining cancellation and the deadline, passed to S1, S2 and adapter calls. | Audit F08; `packages/s1/test/providers.test.ts` |
| **F09** durable intents | IMPLEMENTED_OFFLINE_VERIFIED | The intent states are PREPARED → DISPATCHING → ACKNOWLEDGED/EFFECT_CONFIRMED, with EFFECT_UNKNOWN → RECONCILING → RECONCILED/NEEDS_REVIEW on failure. The first two are persisted, under a fence, before any input. Keyed mutations carry an idempotency key on that dispatch only. Effects are reconciled from the application: receipts must belong to the fixture owner, and absence counts as proof only when nothing is in flight. Unkeyed mutations go to review. | `tests/service/durability.test.ts` (a real worker process group is SIGKILLed mid-checkout); `apps/worker/test/intents.test.ts`; demo flow step 3 |
| **F10** capabilities | IMPLEMENTED_OFFLINE_VERIFIED | Exploration now executes SELECT (with a page-offered option) and SCROLL. Open shadow roots are extracted and actionable. Frame-only pages end as `unsupported_capability`. Loop detection stops repeated page states. A missing browser is reported as BLOCKED `unsupported_capability`. | `tests/e2e/capabilities.test.ts`; `tests/e2e/profiles.test.ts` |
| **CONC** admission/fencing | IMPLEMENTED_OFFLINE_VERIFIED | Admission locks the tenant row while counting active leases. The old query admitted 11 leases against a quota of 2 (`docs/evidence/phase2/`). Every lease increments a fence that guards heartbeats, intents, results and completion. | `tests/service/durability.test.ts`; `tests/service/platform.test.ts` |

The probe outputs after the fixes are in `docs/evidence/closure/audit-probes-after.json`. The baseline before any fix (0/13) is in `evidence/baseline/audit.json`.

The probes were kept verbatim, with only their import paths and scratch paths changed. Their assertions were not weakened.

## 2. Other completion phases

| Phase | State | Summary |
|---|---|---|
| 8 Visual/browser | IMPLEMENTED_OFFLINE_VERIFIED | Baselines are keyed by a rendering digest (browser, OS, viewport, DPR, locale, timezone, colour scheme, motion, font/raster probe). Approval is compare-and-set, backed by migration 005. The Claude visual reviewer is advisory only. Firefox and WebKit are BLOCKED where their binaries are absent. |
| 9 Selection | IMPLEMENTED_OFFLINE_VERIFIED | On a labelled benchmark, selection recall is 1.0 (13/13 seeded defects) with a mean selected fraction of 0.78. A wrong mapping is shown to fail. Advisory exploration never delays the required gate. |
| 10 Operations | IMPLEMENTED_OFFLINE_VERIFIED | Added a Dockerfile and compose stack, fail-closed startup checks (`qa doctor`), a token-protected `/metrics`, and the unattended demo flow, which also runs in CI. |
| 11 Qualification | BLOCKED | Implemented `qualify()`, the registry, `qa qualify`, and worker enforcement. No profile is qualified (`docs/evidence/phase11/qualification-status.json`). |

## 3. Behaviour changes (may affect existing users)

- **Application contract required.** Every control a scenario or explorer touches must be bound in the project policy (`intents`, `routes`, `control_bindings`). An unbound or relabeled control is denied as `unknown_effect`, and a mutating control whose step omits its intent is denied as `missing_intent`. `unknown_actions: read_only_exploration` no longer permits anything.
- **Reload assertions.** `persists_after_reload` reloads with a GET of the current URL and is denied when that route is not registered.
- **Autonomy is off by default.** The worker defaults to `QA_AUTONOMY_MODE=shadow`. Calibrated mode needs a qualification; without one it is downgraded to shadow.
- **Calibration digest.** The decision-configuration digest now uses the resolved model, so earlier calibrations keyed by a requested alias no longer match.
- **Generated specs need the sandbox.** Specs are rejected by the AST lint (for example any import other than `@playwright/test`), and validation requires Linux user namespaces. Without them the result is `error`, never `passed`.
- **Suite revision.** Revisions now change when profiles, the scenario filter, retries or the engine version change. Existing runs therefore stop qualifying for promotion.
- **Baseline approval.** Approval now requires `expected_version`. A lost race returns 409 `baseline_conflict`.
- **Delivery ids.** A reused delivery id with a different payload returns 409 `delivery_payload_mismatch`.
- **New reason code** `effect_unreconciled`, and a new evidence event kind `intent_transition`.

## 4. Migrations and deployment

New migrations:
- `003_intents_fencing.sql`: intents, transitions, receipts, and fences.
- `004_lineage_promotions.sql`: snapshots, generations, and promotion decisions.
- `005_visual_cas.sql`: the unique approval version.

Upgrade order:
1. Stop workers (SIGTERM).
2. Run `qa migrate`.
3. Start the API.
4. Start the workers.

Roles, the full list of configuration keys, and the demo instructions are in [`deploy/README.md`](../deploy/README.md).

New keys: `QA_METRICS_TOKEN`, `QA_LEASE_SECONDS`, `QA_SWEEP_INTERVAL_MS`, `QA_AUTONOMY_MODE`, `QA_QUALIFICATION_DIR`, `QA_S1_TIMEOUT_MS`, `QA_S1_RETRIES`, `QA_S1_COMPAT_RECORD`, `QA_S2_PROVIDER`, `QA_S2_MODEL`, `QA_VISUAL_REVIEWER`, and `ANTHROPIC_API_KEY`.

## 5. Lanes: commands and results (commit `3c3dd97`)

| Lane | Command | Result |
|---|---|---|
| static | `npm run lane -- static` (`tsc --noEmit`) | PASSED |
| unit | `npm run lane -- unit` | 172/172, 0 skipped |
| e2e | `npm run lane -- e2e` | 75/75, 0 skipped |
| service | `QA_REQUIRE_SERVICE=1 DATABASE_URL=… npm run lane -- service` | 36/36, 0 skipped (PostgreSQL 16) |
| audit | `npm run lane -- audit` | 13/13 (baseline before fixes: 0/13) |
| isolation | `npm run lane -- isolation` | 8/8 |
| live | `npm run lane -- live` | **BLOCKED**: missing `QA_S1_API_KEY` (not run, not counted) |
| live_s2 | `npm run lane -- live_s2` | **BLOCKED**: missing `ANTHROPIC_API_KEY` (not run, not counted) |
| spec validation | `npm run qa -- validate` | all scenarios ok |
| deployment flow | `docker build -t jev-ba/qa:local . && node deploy/demo/run-demo.mjs` | PASSED |

The manifests (code SHA, dirty flag, environment, dependency versions, counts, skipped list, digest) are in `evidence/lanes/` and copied to `docs/evidence/closure/`.

## 6. Deployment runs and crash recovery

`docs/evidence/phase10/demo-flow.json`, produced unattended on the built image:

1. **Clean deployment.** All 6 required cases PASS and the gate opens. The promotion is consumed once; a replayed consume returns 409.
2. **Defective deployment** (`total_off_by_one`). `checkout_existing_customer` FAILs and the gate is held. The promotion is refused. A clean decision taken earlier is also refused, because it is no longer the current candidate and a newer generation exists.
3. **Worker SIGKILL mid-checkout.** The checkout intent was `DISPATCHING` when the worker was killed. A replacement worker re-leased the shard after the lease expired, under fence 2. The intent went `DISPATCHING → RECONCILING → RECONCILED` with exactly one order receipt, and the run completed with the gate open. The dead worker's fixtures were swept.

   A `notes.delete` intent that was also in flight was correctly left in `NEEDS_REVIEW`: deletes are not keyed, so the platform does not guess.

Process-level crash evidence from the service lane is in `docs/evidence/phase2/crash-recovery.json`.

## 7. Sanitized artifacts

The audit F06 probe scans every entry of the trace archive for the fixture's session cookie and password values and finds none.

The sanitizer's unit tests show the following:
- Header and cookie values are blanked.
- Secrets are removed in every encoding.
- Unreadable archives are withheld.
- Written artifacts are redacted.

Each sanitized trace records, in the evidence log, which entries were redacted.

## 8. Capability matrix

See [`docs/capability-matrix.md`](capability-matrix.md) (updated): effect authorization, durable intents, sandboxed validation, SELECT/SCROLL, open shadow DOM, frames reported as unsupported, autonomy modes, and vision S2.

## 9. External prerequisites

| Needed for | Prerequisite |
|---|---|
| F01 live (`live` lane) | `QA_S1_API_KEY` for api.typesafe.ai. Confirms the encoding taken from the public Go client and yields a compatibility record. |
| F07 live (`live_s2` lane) | `ANTHROPIC_API_KEY` (optionally `QA_S2_MODEL`) |
| Calibrated autonomy (phase 11) | Representative, double-labelled decisions from the target application; a current live compatibility record naming the calibrated model; at least 50 end-to-end episodes with zero false passes |
| Firefox/WebKit profiles | Browser binaries on the runner |
| Production onboarding | A per-target application contract and adapter (keyed effect lookup for reconcilable mutations), a selection benchmark, and GitHub/Vercel credentials |
| Sandbox on CI | `kernel.apparmor_restrict_unprivileged_userns=0` (set in the workflow) |

## 10. Residual risks and limits

- **Sandbox memory.** Memory is not cgroup-limited inside the sandbox. Processes, file sizes, time and network are limited.
- **Unkeyed mutations.** Only mutations the adapter records under an idempotency key can be reconciled automatically. For fixture-shop that is only `checkout.submit`; the others go to review after a crash.
- **Iframes.** Frame content is not extracted.
- **S2 model refusals.** The S2 provider defaults to `claude-opus-5` without server-side fallbacks, so a refusal is an ABSTAIN. This is deliberate: the model that made a proposal stays pinned.
- **Fixture-only evidence.** Selection recall, detection matrices and the demo flow run against the controlled fixture application. They do not demonstrate coverage of other applications.
