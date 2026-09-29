# Re-audit closure (R1–R5)

This report responds to the independent re-audit of merged PR #2, which reviewed revision
`c750de1f67b9f4c78eec9a0c5f2214bb422c820a`. The work is on branch `claude/new-session-lnwzm0`.

Lane evidence was produced on commit `f203cbf` with a clean tree: every manifest in
`docs/evidence/reaudit-lanes/` records `dirty: false`. The unattended deployment flow ran on an
image built from that code. This document and the files it updates were committed after that
evidence, and they change documentation only.

**Bottom line.** All five re-audit findings are implemented and verified offline.

- **Probes.** The seven re-audit probes fail at `c750de1` (7/7 assertion failures) and pass on
  this branch.
- **Earlier probes.** The 13 original audit probes still pass.
- **Offline lanes.** Every offline lane passes and no test was skipped.
- **Still outstanding.** This is not a production-autonomy qualification:
  - The live Jev (F01) and vision-S2 (F07) lanes are BLOCKED on credentials.
  - Calibrated autonomy remains BLOCKED for every profile.
  - The evidence covers the controlled fixture application only.
- **Reporting.** Code completion and operational/live qualification are reported separately in
  §3.

## 1. Findings

| Finding | State | What changed | Verified by |
|---|---|---|---|
| **R1** Uncertain effects survive recovery while the run becomes eligible | IMPLEMENTED_OFFLINE_VERIFIED | **Recovery.** An acknowledged mutation is no longer treated as resolved. Keyed mutations end `EFFECT_CONFIRMED` or `RECONCILED` after an application lookup. Unkeyed mutations become `SETTLED` only when their owning attempt finishes under the same live lease. Anything a dead worker left `ACKNOWLEDGED` is reconciled on recovery.<br><br>**Obligations.** `NEEDS_REVIEW` is an outstanding obligation across every later fence, attempt and recovery pass. Only an admin can resolve it, with an audited adjudication: `POST /v1/intents/:id/adjudicate` names the actor, the resolution and what was checked.<br><br>**Gating.** The shard worker never replays a case that has an open obligation, and reports that case `NEEDS_REVIEW`. Aggregation consults every obligation of the deployment, and so do the live gate, promotion decisions and consume. In-flight effects of advisory shards count as well, so fresh passing results cannot erase an uncertain effect.<br><br>**Fixture adapter.** It now also keys `cart.add`. | Probes R1a/R1b/R1c; `apps/worker/test/obligations.test.ts`; `tests/service/obligations.test.ts`, which runs on PostgreSQL with real worker processes killed by SIGKILL (browser included). There are two scenarios:<ul><li>**Acknowledgement/confirmation boundary.** The first worker is killed there, and the replacement is killed during its lookup. The third worker completes the lookup. The checkout is never replayed and exactly one order exists.</li><li>**Unkeyed deletion killed in flight.** The run is restarted twice. There is no replay. A mixed shard (one PASS plus one held case) keeps the gate and the promotion held until adjudication and a retry.</li></ul>The deployment demo now asserts the hold: `docs/evidence/reaudit-demo/demo-flow.json`. There, an acknowledged but unsettled `notes.create` from the killed worker held the gate and refused promotion. After adjudication and a retry, the deployment promoted. |
| **R2** Execution identity omits verdict-relevant configuration | IMPLEMENTED_OFFLINE_VERIFIED | **The contract.** The run revision is now the digest of a typed execution contract, which covers:<ul><li>the suite snapshot;</li><li>the effective environment policy;</li><li>the oracle adapter's identity, version and endpoint (the credential reference is hashed and never included in clear);</li><li>version-verification settings;</li><li>approved baselines, frozen by version and checksum at submission;</li><li>the pinned browser build and context-option digest for each profile;</li><li>the decision configuration that can decide a required verdict.</li></ul>**Selection manifest.** It has its own frozen identity, recorded on runs and decisions.<br><br>**Where it is checked.** The contract is compared at submission, before each shard executes, at aggregation (so a change made mid-run is caught), and at every gate evaluation, decision and consume. Stale reasons name the sections that changed.<br><br>**At execution.** Only the frozen baseline versions are read, and a browser build other than the pinned one is refused.<br><br>**Retry.** A retry is a new execution under the current contract. It is refused when the suite itself changed. | Probes R2a (the identity differs by oracle backend; at `c750de1` both backends produced `suite_27736253629c136a`) and R2b; `packages/orchestrator/test/contract.test.ts`; `tests/service/execution-contract.test.ts`, which:<ul><li>changes the oracle endpoint, the credential reference, the environment policy, version verification, retries and the required profiles, each on its own, after a passing run and an eligible decision, and shows that neither qualifies any more;</li><li>shows that a change made before execution is refused and one made after execution is caught at aggregation;</li><li>shows that a baseline approved later is used only by a new execution.</li></ul> |
| **R3** Deployment channels and authoritative ordering | IMPLEMENTED_OFFLINE_VERIFIED (controller integration external) | **Lineage.** Environments declare `lineage: single` or `per_channel`. Under `per_channel`, each verified provider channel is its own lineage (for example pull-request previews), and a deployment whose channel cannot be established is refused.<br><br>**Ordering.** It comes from verified provider state:<ul><li>the GitHub deployment id;</li><li>Vercel `createdAt`;</li><li>the pipeline's `sequence`.</li></ul>If a lineage's deployments carry none of these, serialized arrival is used instead. The mode is fixed by the lineage's first deployment, and a deployment of the other kind is refused. A late old event is recorded as stale and is never tested or made current. A tie holds the lineage until a strictly newer deployment arrives.<br><br>**Serialization.** One locked row per channel serializes gapless generation allocation, the current candidate and supersession. Consume locks the same row, so a concurrently registered candidate lands entirely before or entirely after the promotion.<br><br>**Delivery identity and statuses.** Delivery identity is scoped to tenant and project. A late status from a replaced deployment of the same commit is never published over the status the current candidate owns. Consume returns the exact deployment, channel and generation for the controller to bind to. | `tests/service/lineage.test.ts` covers:<ul><li>independent sibling previews;</li><li>an old event delivered after a new one;</li><li>a tie, and mixed ordering refused;</li><li>eight concurrent distinct submissions, which get gapless generations with one current candidate;</li><li>five rounds of a candidate registered concurrently with consume, where the audit order proves serialization;</li><li>two deployments of one SHA plus a late status publication.</li></ul> |
| **R4** Text sanitization does not redact secrets rendered into pixels | IMPLEMENTED_OFFLINE_VERIFIED | **Masking before capture.** Every image is made safe in the page before capture. `safeScreenshot` masks:<ul><li>every rendered element whose visible text or form value contains a registered secret, across all frames and open shadow roots, including secrets split across elements or case-transformed;</li><li>every declared selector (new policy field `privacy.mask_selectors`);</li><li>everything that cannot be inspected: cross-origin frames, closed-shadow custom elements, canvas, video and embedded objects.</li></ul>**Re-check.** The page is checked again after capture. If safe masking cannot be established, or a secret appeared during capture, the image is withheld and that is recorded.<br><br>**Where it applies.** Evidence and failure screenshots, visual checkpoints (and so their diffs and reviewer inputs), and the System Two request image all go through it.<br><br>**Traces.** They are recorded without screencast frames. The sanitized trace derivative omits every image resource, detected by file signature, and records the omission. | Probe R4; `tests/e2e/pixel-privacy.test.ts` checks decoded pixels:<ul><li>a synthetic secret is masked in ordinary text, a non-password input, expanded details, a same-origin frame, split and uppercased text, a closed shadow root and a canvas, while a non-sensitive heading survives;</li><li>an unmasked capture of the same page shows the leak, so the test can detect one;</li><li>a secret appearing mid-capture withholds the image;</li><li>a real attempt with a fixture secret shown on every page exports only masked screenshots and an image-free trace, and the S2 request image is masked too.</li></ul> |
| **R5** Qualification freshness checked only at creation | IMPLEMENTED_OFFLINE_VERIFIED | **Expiry.** A qualification records `expires_at`: it lapses `max_compat_age_days` after the live compatibility probe it was granted on.<br><br>**Registry.** It takes a clock and enforces expiry and revocation on every lookup. Corrupt records, legacy records without an expiry, and unreadable records never authorize anything, and an unreadable revocation still revokes.<br><br>**Renewal.** A grant is renewed only on a current, validating probe of the exact qualified model, and the renewal is kept in history. Operators use `qa qualification renew` and `qa qualification revoke`.<br><br>**Long-running workers.** The worker binds the grant's expiry into the calibrated gate, which re-checks it at every decision, so a long-running worker stops acting at expiry. | Probe R5 (a 1996 grant with a 30-day window was still returned at `c750de1`); `packages/calibration/test/qualification.test.ts` covers the expiry boundaries (just before, at, and decades later), a long-running registry, revocation, corrupt and legacy records, and renewal rules; `packages/gate/test/gate.test.ts` shows the gate stops acting mid-run at expiry. |

### Reproduction

`tests/audit/reaudit.test.ts` is now part of the mandatory audit lane. It uses only APIs that
existed at the reviewed revision, feature-detecting the newer identity API.

| Where | Result | Log |
|---|---|---|
| Worktree at `c750de1` | 7/7 assertion failures, no setup errors | `docs/evidence/reaudit/probes-at-c750de1.txt` |
| This branch | 7/7 pass | `docs/evidence/reaudit/probes-after-fix.txt` |

The re-audit's own review bundle was not available in this environment, so these probes were
written from the report's descriptions. They preserve its safety requirements: no assertion is
weaker than the report's.

## 2. Lanes (commit `f203cbf`, clean tree)

| Lane | Command | Result |
|---|---|---|
| static | `npm run lane -- static` | PASSED |
| unit | `npm run lane -- unit` | 185/185, 0 skipped |
| e2e | `npm run lane -- e2e` | 79/79, 0 skipped |
| service | `QA_REQUIRE_SERVICE=1 DATABASE_URL=… npm run lane -- service` | 48/48, 0 skipped (PostgreSQL 16) |
| audit | `npm run lane -- audit` | 20/20: 13 original probes plus 7 re-audit probes |
| isolation | `npm run lane -- isolation` | 8/8 |
| live | `npm run lane -- live` | **BLOCKED**: missing `QA_S1_API_KEY` (not run, not counted) |
| live_s2 | `npm run lane -- live_s2` | **BLOCKED**: missing `ANTHROPIC_API_KEY` (not run, not counted) |
| spec validation | `npm run qa -- validate` | all scenarios ok |
| deployment flow | `docker build -t jev-ba/qa:local . && node deploy/demo/run-demo.mjs --out docs/evidence/reaudit-demo` | PASSED |

The manifests are in `docs/evidence/reaudit-lanes/`. The mandatory CI matrix runs the same lanes
on the pushed commit.

## 3. Phase status: code completion vs operational qualification

"Code" means the mechanism is implemented and verified offline against the fixture application.
"Operational" means it is verified live, or qualified for a real target profile. The first never
implies the second.

| Phase | Code | Operational / live |
|---|---|---|
| 0 Reproducible baseline | Complete: explicit lanes, manifests, audit and re-audit probes are mandatory | CI runs the matrix on each commit |
| 1 Effect authorization | Complete | Needs a contract per target application |
| 2 Durable execution | Complete (R1): obligations hold the gate across restarts; PostgreSQL process-kill tests | Needs a target-application adapter with keyed effect lookup for each reconcilable mutation; unkeyed effects need human adjudication |
| 3 Privacy and isolation | Complete (R4): masking before capture, image-free traces; namespace sandbox with nproc, nofile, fsize and time limits | **No cgroup memory bound** in the sandbox (limit). Server-rendered images that show secrets are masked only when declared. |
| 4 Jev transport | Complete offline | **LIVE_VERIFICATION_REQUIRED** (`QA_S1_API_KEY`) |
| 5 Modes and calibration identity | Complete (R5): time-bounded, revocable grants re-checked at every decision | Shadow by default; nothing is qualified |
| 6 Observation and S2 | Complete offline | **LIVE_VERIFICATION_REQUIRED** (`ANTHROPIC_API_KEY`); frame content is not extracted |
| 7 Deployment and promotion | Complete (R2, R3) | A real deployment controller must bind to the consumed deployment/channel/generation; GitHub/Vercel paths need live credentials |
| 8 UI/UX quality | Complete for Chromium desktop and mobile viewport on the fixture | Firefox and WebKit are BLOCKED without their binaries; viewport emulation is not native-device evidence; real-target evidence is needed for any claimed profile |
| 9 Selection and compilation | Complete on the fixture benchmark (recall 13/13) | General target-application recall is not established |
| 10 Operations and onboarding | Complete: image, compose, startup checks, metrics; the demo flow passes in CI | Real target onboarding and provider-controller integration are not established |
| 11 Qualification | Tooling complete | **BLOCKED**: no representative labelled data, live provider record or target episodes |

## 4. Behaviour changes and upgrade

- **New migrations** (apply with `qa migrate`):
  - `006_effect_obligations`
  - `007_execution_contract`
  - `008_deployment_channels`
- **Revisions change.** Runs selected before the upgrade no longer qualify, because the contract
  now covers more settings (engine `engine-2026.09-r2`). Re-run them.
- **Promotion decisions.** Migration 008 renumbers existing run generations, so outstanding
  decisions are refused. Take them again.
- **Qualifications.** Records written before this release have no expiry and no longer authorize
  anything. Qualify again.
- **Crashes can now hold the gate.** A crash that leaves an unverifiable effect holds the gate
  until an admin adjudicates it; the held cases then need a retry. The endpoints are
  `GET /v1/runs/:id/obligations` and `POST /v1/intents/:id/adjudicate`.
- **Preview environments.** They can declare `lineage: per_channel`. A lineage cannot mix
  provider-ordered and arrival-ordered deployments (422 `ordering_unverifiable`). A late old
  event returns 202 with a `not tested` note.
- **Delivery ids** are scoped to tenant and project.
- **Images.** Screenshots mask more content (magenta `#FF00FF`). Traces no longer contain
  screenshots or image resources.
- **The fixture adapter keys `cart.add`**, and its version is now `fixture-shop-adapter/3`.

The details are in [`deploy/README.md`](../deploy/README.md).

## 5. Remaining limits and external prerequisites

- **Live verification.** It needs `QA_S1_API_KEY` for F01 and `ANTHROPIC_API_KEY` for F07.
  Both lanes are BLOCKED here and are never counted as passing.
- **Calibrated autonomy.** It needs representative, double-labelled decisions from the target
  application, at least 50 end-to-end episodes with no false passes, and a current live
  compatibility record for the calibrated model. Until then, workers run exploration in shadow
  mode.
- **Sandbox memory** is not cgroup-limited.
- **Pixel privacy.** Secrets drawn by the server into ordinary images are masked only when the
  policy declares their selector.
- **Deployment controllers.** The platform returns what to promote. The controller that
  actually promotes must bind to it, and no real controller integration was exercised.
- **Fixture-only evidence.** Every browser, service and demo result here concerns the fixture
  application.
