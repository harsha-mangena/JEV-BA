# Autonomous QA

A web testing service that combines approved, repeatable regression journeys with
bounded System One (S1)–guided exploration. A deterministic controller owns
deployment identity, fixtures, permissions, browser actions, verification and
verdicts; model providers only return typed proposals.

The design is specified in [`docs/implementation-plan.md`](docs/implementation-plan.md).
This repository implements it in dependency order.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Contracts, fixture app with seeded defects, specs, decision records | **Done** |
| 1 | Deterministic Playwright runner, independent verdicts, evidence, reports, CLI | **Done** |
| 2 | Observation model, node registry, S1 adapter interface, response validation | **Core done** — no live provider adapter yet (see below) |
| 3 | Policy-first gate, S2 proposal contract, bounded exploration driver | **Core done** — gate thresholds are heuristic and uncalibrated |
| 4 | Deployment-triggered orchestration (ingress, jobs, status publishing) | Contracts only (envelope, dedup key, manifest check) |
| 5–9 | Visual/a11y, change impact, regression compilation, calibration, production service | Not started |

**Not yet implemented, deliberately:** a live TypeSafe/Jev adapter. The provider's
wire format could not be verified from the build environment, and the plan
requires a live compatibility check rather than a guessed contract. Adding it
means implementing `SystemOneProvider` (`packages/s1/src/types.ts`) and passing
the existing validation and exploration test suites against it.

## Quick start

```bash
npm ci
npx playwright install chromium   # skip if a matching Chromium is already installed
npm run typecheck
npm test                          # unit tests
npm run test:e2e                  # browser tests against the fixture app

npm run qa -- validate            # validate every scenario against catalog + policy
npm run qa -- demo                # start the fixture app in-process and run the suite
npm run qa -- demo --defects total_off_by_one,validation_bypass   # watch the gate hold
```

Against a deployed target:

```bash
QA_FIXTURE_TOKEN=... npm run qa -- run \
  --base-url https://pr-123.preview.example.dev \
  --environment preview \
  --commit-sha <40-char sha>      # execution is BLOCKED if the target reports another revision
```

Exit code `0` means the release gate is eligible, `1` means it is held, `2` is a
usage or contract error. Evidence (`report.html`, `junit.xml`, `report.json`,
per-attempt `events.jsonl`, screenshots, traces) is written under `.qa-runs/`.

## Layout

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Zod schemas and pure logic: scenarios, policy, fixtures, deployment envelope, verdicts, run lifecycle, release gate |
| `packages/browser` | Locators, step executor (actionability-checked, never `force`), execution profiles, observation + node registry |
| `packages/oracles` | Fixture-service client and independent UI/backend assertions |
| `packages/evidence` | Append-only redacted event log, checksummed artifacts, JUnit and HTML reports |
| `packages/s1` | Provider-neutral S1 request model, question builder, response validation, offline fakes |
| `packages/gate` | Policy-first gate with mandatory stage ordering |
| `packages/s2` | Typed S2 proposal contract and validation |
| `apps/worker` | Attempt session, regression and exploration drivers, suite runner |
| `apps/cli` | `validate`, `run`, `demo` |
| `fixtures/test-app` | Controlled shop application with ten switchable defects and a token-protected fixture API |
| `specs/` | Project policy, fixture catalog, approved regression scenarios, exploration scenarios |
| `docs/` | Plan, ADRs, defect catalog, capability matrix, threat boundaries, requirement map |
| `evals/` | Placeholder for labeled observations and calibration data (Phase 8) |

## Verdicts

Only `PASS` can satisfy a release gate, and only when **every** expected
(scenario, profile) case is present and passed. A missing case, a retry that
passed after a failure (`FLAKY`, preserved for critical journeys), a
`BLOCKED`/`ERROR`, a cleanup failure, or a revision mismatch all hold the gate.
Exploration results are advisory and never satisfy it. A `PASS` covers only the
listed requirements and assertions; it says nothing about untested behaviour.

See [`docs/capability-matrix.md`](docs/capability-matrix.md) for what is and is
not covered today.
