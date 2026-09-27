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

Not demonstrated here: behaviour against a live TypeSafe endpoint, a live
Vercel project, and real-world calibration data — each has a probe or guide
(`qa s1 probe`, `docs/deployment-integration.md`, `evals/README.md`).
