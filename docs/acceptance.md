# Release-readiness acceptance (plan §14)

| Criterion | Demonstrated by |
| --- | --- |
| A deployment event identifies and tests the exact revision without manual startup | `tests/service/orchestration.test.ts` › *a signed webhook launches the suite…*; *blocks execution when the target serves a different revision*; *pipeline submissions bind URL and SHA…* |
| Duplicate events do not create duplicate logical runs or unsafe side effects | *ten duplicate deliveries create exactly one logical run*; `platform.test.ts` › *recovers from worker loss without duplicating work…* |
| Critical seeded defects fail their approved requirements | `tests/e2e/regression.test.ts` detection matrix; `quality.test.ts` matrix; the catalog-coverage test keeps both complete |
| DONE, confidence, retries, missing tests and infrastructure errors cannot manufacture PASS | `exploration.test.ts` › *a DONE claim cannot hide a product defect*, *provider outage → ERROR*; `runner-safety.test.ts` › FLAKY, fixture error; `contracts.test.ts` › missing shard; *a permanently failed shard holds the gate* |
| S1 and S2 remain within deterministic permission and freshness checks | `gate.test.ts` (forbidden with perfect scores, stale nodes, S2 re-entry); `exploration.test.ts` › unauthorized mutation, unknown semantics, rogue S2 |
| Model uncertainty and UX hypotheses are labelled honestly | `quality.test.ts` › *UX hypotheses require structural corroboration*; gate reason codes `heuristic_gate_uncalibrated`, `s2_selected_uncalibrated`, `calibration_config_mismatch` |
| Required results aggregate every expected case/shard and cannot approve another deployment | *deployment A's late result can never approve deployment B*; `evaluateReleaseGate` tests |
| Visual baselines, repaired tests and requirement changes have independent versioned review | `platform.test.ts` › visual review loop; `quality.test.ts` › approval refusals; `compiler.test.ts` › repair classification; proposal approval (`qa proposals approve`, `POST /v1/scenarios/:id/approve`) |
| Calibration and end-to-end measurements expose sample sizes, coverage and limitations | `calibration.test.ts`; `CalibrationReport.sample_counts`, `limitations`, cohort support |
| Reports let an engineer reproduce a finding from deployment, fixture, scenario and evidence identifiers | Case results carry attempt ids, deployment and SHA, fixture ids in events, checksummed artifacts; dashboard run pages |

## Completion phases (audit F01–F10)

| Criterion | Demonstrated by |
| --- | --- |
| Every driver authorizes by effect; missing, misspelled or conflicting intents, relabeled controls, unaccepted parameters and unauthorized autosave never reach the backend (F02) | `tests/e2e/authorization.test.ts` (backend write journal + adapter entity oracle); `packages/contracts/test/authorize.test.ts`; audit F02a/F02b |
| Possibly-dispatched effects survive worker loss and are reconciled from the application, never duplicated (F09); leases are fenced and tenant admission is atomic | `tests/service/durability.test.ts` (real worker process SIGKILLed mid-checkout); `docs/evidence/phase2/`; `docs/evidence/phase10/demo-flow.json` step 3 |
| Generated code cannot touch the host (F03); traces and artifacts carry no credentials (F06) | `tests/isolation/sandbox.test.ts`; `packages/compiler/test/lint.test.ts`; `packages/evidence/test/sanitize.test.ts`; audit F03/F06 |
| S1 speaks the published contract (F01) with bounded transport and combined cancellation (F08) | `packages/s1/test/providers.test.ts`; audit F01a/F01b/F08; live lane (BLOCKED without credentials) |
| Autonomy modes, calibration identity and resolved-model binding (F04) | `packages/gate/test/gate.test.ts`; audit F04a/F04b/F04c; `tests/service/promotion.test.ts` (qualification downgrade) |
| Vision S2 with screenshots and fulfilled context requests (F07); explicit action/frame/browser capabilities (F10) | `tests/e2e/capabilities.test.ts`; `packages/s2/test/anthropic.test.ts`; audit F07; `tests/e2e/profiles.test.ts` |
| Results are bound to an execution snapshot; promotions are single-use and re-checked (F05) | audit F05/F05b; `tests/service/promotion.test.ts` |
| A clean deployment is promoted, a defective one is held, a crashed worker recovers — unattended, on the built image | `deploy/demo/run-demo.mjs` → `docs/evidence/phase10/demo-flow.json` |

Not demonstrated here: behaviour against a live TypeSafe endpoint or a live
Claude vision call (credentials absent: the `live` and `live_s2` lanes are
recorded as BLOCKED), a live Vercel/GitHub project, and representative
calibration data (no profile is qualified: `docs/evidence/phase11/`). Each has a
probe or guide (`qa s1 probe`, `docs/deployment-integration.md`, `evals/README.md`,
`qa qualify`).
