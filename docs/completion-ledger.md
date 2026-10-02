# Completion ledger (post-PR #5 plan)

One row per remaining requirement. A partial requirement stays partial, and a result counts only
when its evidence path shows it.

- **Baseline:** `524a8e96cb98c89c99e265a9836682c09ee4cda5`, the merge of PR #5.
- **Environment:**
  - Linux, root, Node v22.22.2, Chromium 141 (Playwright 1.56.1);
  - PostgreSQL 16 on local port 55432;
  - cgroup v1 with swap accounting (`memory.memsw.*`) and no host swap;
  - user namespaces available.
- **Not available in this environment:**
  - provider credentials;
  - a target application;
  - Firefox and WebKit binaries;
  - a deployment environment.

## Phase 0: baseline

The mandatory lanes were run on `524a8e9` before any change. Logs and manifests are in
`docs/evidence/completion/baseline-524a8e9/`.

| Lane | Result |
|---|---|
| static | PASSED |
| unit | 189/189 |
| e2e | 98/98 |
| service | 49/49 |
| audit | 30/30 |
| isolation | 16/16 |
| live | BLOCKED: `QA_S1_API_KEY` |
| live_s2 | BLOCKED: `ANTHROPIC_API_KEY` |
| scenario validation | ok |

- **Totals:** 382 tests and zero skips, the same as the baseline counts of CI run 36761556682.
- **The `dirty: true` flag:** the lanes after `static` record it only because the baseline logs
  themselves were being written, untracked, to `docs/evidence/completion/`. No source file differed
  from `524a8e9`.

## Remaining requirements

| Requirement | Owner / input needed | Code | Test | Command | Observed result | Evidence |
|---|---|---|---|---|---|---|
| **C1:** closed roots on ordinary hosts | none | `packages/browser/src/privacy.ts` (`markOpaqueHosts`) | `tests/audit/completion.test.ts` (C1), `tests/e2e/pixel-privacy.test.ts` (completion C1 and closed-content export) | `npx vitest run --config vitest.audit.config.ts tests/audit/completion.test.ts` | **At `524a8e9`:** reproduced; div and span hosts accepted with 2,677 of 2,677 secret pixels unsanitized. **After the fix:** 0 unsanitized, and the controls pass. | `docs/evidence/completion/probes/c1c2-at-524a8e9.txt`, `c1c2-after-fix.txt`, `c1-e2e-with-524a8e9-privacy.txt` |
| **C2:** v1 memory-and-swap bound | none | `packages/compiler/src/cgroup.ts`, `sandbox.ts`, `validate-spec.ts` | `tests/audit/completion.test.ts` (C2), `tests/isolation/resource-contract.test.ts` | as above; `npm run lane -- isolation` | **At `524a8e9`:** reproduced; a denied write and a weaker read-back of `memory.memsw.limit_in_bytes` both let the program run. **After the fix:** refused with a typed reason, and the program never starts. | the same files as C1 |
| Live Jev (S1) | scoped `QA_S1_API_KEY`, and the provider's current official endpoint and contract | `packages/s1/src/providers.ts`, `transport.ts` | `tests/live/s1-contract.test.ts` | `npm run lane -- live` | **BLOCKED:** credential missing | `docs/evidence/completion/baseline-524a8e9/live.json` |
| Live S2 (vision) | scoped `ANTHROPIC_API_KEY`, and permission to send sanitized synthetic images | `packages/s2/src/anthropic.ts` | `tests/live/s2-vision.test.ts`: the image now goes through `safeScreenshot`, with a closed-root canary checked on pixels before sending | `npm run lane -- live_s2` | **BLOCKED:** credential missing. An offline dry run with a closed local port passed the canary checks and then stopped at the refused connection. That dry run is *not* provider proof. | `live_s2.json`, `docs/evidence/completion/probes/live-s2-offline-dry-run.txt` |
| Real target onboarding | every input in `docs/templates/target-onboarding.yaml`, from the application owner | `packages/contracts/src/onboarding.ts`, `qa onboarding-check` | `packages/contracts/test/onboarding.test.ts` | `npm run qa -- onboarding-check --manifest <file>` | **BLOCKED:** the template reports 11 missing owner inputs | `docs/evidence/completion/onboarding-template-check.txt` |
| Deployment enforcement | the target, deployment-provider access, the owner's promotion controller and a disposable environment | `packages/integrations/`, the promotion API | `tests/service/lineage.test.ts`, `tests/service/promotion.test.ts`, Docker demo | `docs/target-onboarding.md` §3 | **BLOCKED** on the target. Fixture mechanism: pass. | the service lane manifest and the demo evidence |
| Browser and device profiles | the required profile list, Firefox and WebKit binaries, native devices | `packages/browser` | `tests/e2e/profiles.test.ts` (Chromium only) | `npm run lane -- e2e` | **BLOCKED:** only Chromium is installed. Outside Chromium, screenshots are withheld by design (C1). | e2e manifest |
| Autonomous qualification | representative labelled target decisions, held-out episodes, live compatibility records | `packages/calibration`, `qa qualify` | `packages/calibration/test/qualification.test.ts` | `qa qualify …` | **BLOCKED:** no target data. Workers run in shadow mode. | the inventory item `P11-QUALIFICATION` |
| Operational acceptance | the intended runner, database, storage and deployment environment | `deploy/`, `qa doctor` | `tests/service/*` (local PostgreSQL 16 only) | `docs/operations.md` | **BLOCKED:** no target environment | the service lane manifest |

The final-commit lanes are recorded in `docs/completion-report.md` §5.
