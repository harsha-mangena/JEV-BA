# Completion report (post-PR #5 plan)

This report covers the plan of 30 September 2026. It starts from `524a8e9`, the merge of PR #5,
and the work is on branch `claude/new-session-lnwzm0`.

The per-requirement ledger is `docs/completion-ledger.md`. The runbook for target and deployment
acceptance is `docs/target-onboarding.md`.

## 1. Readiness, stated separately

Each level is stated on its own; passing one does not establish another.

| Statement | Status | Basis |
|---|---|---|
| **Platform regression verified** | **Yes, for the fixture scope.** All mandatory offline, service, audit and isolation lanes pass on the final commit (§5). | Lane manifests (§5) |
| **Provider compatible** | **No: BLOCKED.** | No `QA_S1_API_KEY` or `ANTHROPIC_API_KEY`. The live lanes are recorded as BLOCKED, not as passing. |
| **Target deterministic gate ready** | **No: BLOCKED.** | No target application, deployment access or promotion controller has been supplied. `qa onboarding-check` reports 11 missing owner inputs. |
| **Target autonomous profile qualified** | **No: BLOCKED.** | No representative labelled data or target episodes. Workers stay in shadow mode. |

## 2. Findings C1 and C2

Both were source-review hypotheses. Each was executed at the baseline before anything was changed.

| Finding | At `524a8e9` (before) | After | Evidence |
|---|---|---|---|
| **C1:** a secret inside a closed shadow root on a plain `div` or `span` | **Reproduced.** The image was accepted with 2,677 of 2,677 secret glyph pixels unsanitized, on both hosts. The two controls were sanitized: the same host declared as a selector, and a custom-element host. | 0 pixels unsanitized. The check is against the page rendered *without* the secret (or the mask colour), so recolouring or shifting a secret cannot pass. | `docs/evidence/completion/probes/c1c2-at-524a8e9.txt`, `c1c2-after-fix.txt` |
| C1, broader e2e cases | With the baseline `privacy.ts`, 10 of 11 new tests fail. The one that passes is the cross-origin frame, which was already masked as a whole iframe. | 11 of 11 pass | `docs/evidence/completion/probes/c1-e2e-with-524a8e9-privacy.txt` |
| **C2:** a v1 `memory.memsw.limit_in_bytes` that is denied, or that reads back weaker than requested | **Reproduced.** The program ran in both cases, on a cgroup v1 host. | Execution is refused with `control_write_failed` or `limit_mismatch`. The program never starts, and no group is left behind. | the same probe files, and `tests/isolation/resource-contract.test.ts` |

### C1 fix

Detection is in `packages/browser/src/privacy.ts` (`markOpaqueHosts`).

**Discovery.** Chromium inventories every closed shadow root through the DevTools protocol, whatever
the host's tag:
- in the main document;
- in same-process frames;
- in each out-of-process frame target.

This covers pre-existing roots, declarative roots, nested roots, and roots attached after
navigation. The outermost host that page script can reach is marked as sensitive and opaque. Its
content cannot be read, so it cannot be shown to be free of secrets.

**Suppression.** The existing verified suppression then applies unchanged:
- inline and first-cascade-layer `!important` rules;
- verification of closed and user-agent shadow trees through the protocol;
- no pixel tolerance.

**Other behaviour.**
- A browser without the DevTools protocol (Firefox, WebKit) withholds every image. There,
  `shadowRoot === null` does not prove there is no closed root.
- Content that appears after discovery is caught by the re-scan after capture, which withholds the
  image.
- A failed capture attempt counts as an attempt and is retried, up to the bound. On success, retry
  and error alike, the page is left byte-identical:
  - no marks;
  - no stylesheets;
  - no mutation observers;
  - inline styles restored exactly (through the CSSOM only where a CSP blocks the attribute).

**Export paths.** The fixture application gained a closed-root credential echo, a plain `div` with a
declarative closed root. A synthetic secret shown that way is masked in:
- evidence screenshots;
- visual candidates and diffs;
- the S2 request image, checked through a recording provider double.

Traces already publish no images.

**Live S2 test.** It now sends only a `safeScreenshot` image, after checking a closed-root canary on
the decoded pixels.

**Limits.**
- **Threat model.** A page script that deliberately rewrites the CSSOM *within* the capture window,
  without any DOM change, is still out of scope. Where that matters, set model sharing to
  `text_only`.
- **Masked values.** A masked region proves nothing about the value it hides. Such values need a
  backend or UI oracle.

### C2 fix

The code is in `packages/compiler/src/cgroup.ts`, and the contract is in `deploy/README.md` under
"Sandbox resource contract".

**Memory and swap.** Resident memory plus swap for the whole process tree stays within the limit.
How that is established depends on the host:

| Host | How the bound is established |
|---|---|
| cgroup v2 | `memory.swap.max = 0`: no swap at all |
| cgroup v1 | `memory.memsw.limit_in_bytes` equal to the memory limit: a combined bound, so some swap is possible but never beyond the total |
| Kernel without swap accounting | allowed only on a host whose `/proc/swaps` lists no swap |

Each bound is written, then read back to within a page. Otherwise the run is refused with one of
these typed reasons:
- `control_write_failed`;
- `limit_mismatch`;
- `swap_unbounded`;
- `controller_missing`;
- `invalid_config`;
- `membership_unverified`.

**Process cap.**
- `pids.max` is read back.
- On v1, when the runner cannot create a pids group, the only process bound is `RLIMIT_NPROC`. The
  kernel counts that per user, not per sandbox, and it is recorded as such, never as a cgroup cap.

**Recording.** The guarantee, and how each part was established, is returned on every run.

**Configuration.** An invalid numeric limit, including `QA_SANDBOX_MEMORY_MB`, is an error rather
than a silent default.

**Kernel enforcement vs fault injection.** Kernel enforcement (OOM of the whole tree and of its
descendants) is proven only in `tests/isolation/sandbox.test.ts`, on real v1 locally and on v2 in
CI. Fault injection, which perturbs control-file I/O only, is a separate test file.

## 3. Inherited findings

These remain closed, and their probes run in the mandatory audit lane on the final commit:
- F01 to F10 and CONC: `tests/audit/review.test.ts`;
- R1 to R5: `reaudit.test.ts`;
- N1 to N3: `reaudit3.test.ts`;
- P4a to P4c: `reaudit4.test.ts`;
- C1 and C2: `completion.test.ts`.

The histories are in `docs/closure-report.md`, `reaudit-closure.md`, `review3-closure.md` and
`review4-closure.md`. The inventory keeps C1 and C2 with their `history`, from
`SOURCE_REVIEW_PENDING_REPRODUCTION` through `REPRODUCED` to `IMPLEMENTED_OFFLINE_VERIFIED`.

## 4. Requirement-to-test matrix

| Requirement | Tests |
|---|---|
| Effect authorization | `tests/e2e/authorization.test.ts`, `packages/contracts/test/authorize.test.ts`, `packages/gate/test/gate.test.ts`, audit F02a and F02b |
| Durable intents and reconciliation | `tests/service/durability.test.ts`, `apps/worker/test/intents.test.ts`, `tests/service/obligations.test.ts`, `tests/e2e/retry-obligations.test.ts`, audit N2a and N2b |
| Privacy | `tests/e2e/pixel-privacy.test.ts`, audit R4, N1a/N1b, P4a/P4b and C1 |
| Isolation and resources | `tests/isolation/sandbox.test.ts`, `tests/isolation/resource-contract.test.ts`, `packages/compiler/test/lint.test.ts`, audit F03, P4c and C2 |
| Provider compatibility | `packages/s1/test/providers.test.ts`, `packages/s2/test/anthropic.test.ts`, audit F01 and F07. `tests/live/*` are **BLOCKED**. |
| Immutable execution identity | `packages/orchestrator/test/contract.test.ts`, `tests/service/execution-contract.test.ts`, audit R2a, R2b, F05 and F05b |
| Deployment lineage and promotion | `tests/service/lineage.test.ts`, `tests/service/promotion.test.ts`, Docker demo |
| Tenant boundaries | `tests/service/durability.test.ts`, `tests/service/platform.test.ts` |
| Visual approvals | `tests/e2e/quality.test.ts`, `tests/e2e/profiles.test.ts`, `tests/service/platform.test.ts` |
| Controlled repairs | `tests/e2e/compiler.test.ts` |
| Qualification | `packages/calibration/test/qualification.test.ts`, `packages/orchestrator/test/qualification-runtime.test.ts`, `packages/gate/test/gate.test.ts`, audit F04a–c, R5 and N3 |
| Target onboarding (inputs) | `packages/contracts/test/onboarding.test.ts` |

## 5. Lanes on the final commit

LANES_PLACEHOLDER

## 6. Plan coverage and blocked steps

**Phase 0: done.**
- Baseline manifests are recorded.
- C1 and C2 are in the inventory with their reproduction history.
- The ledger is written.

**Phase 1: done for Chromium.** Firefox and WebKit withhold every image. Their screenshot capability
is blocked on those engines' binaries and on the absence of an equivalent introspection protocol.

**Phase 2: done.** Swap and process guarantees are corrected in the documentation.

**Phase 3: partial.**
- Done: the live S2 image goes through the sanitizer, with a canary check.
- **Blocked:** the authenticated Jev and S2 runs, resolved-model records, the multi-head format
  check against the real provider, and cost and latency figures. They need `QA_S1_API_KEY`,
  `ANTHROPIC_API_KEY`, and the provider's current official contract.

**Phase 4: partial.**
- Done: the manifest schema, the checker, the template and the runbook.
- **Blocked:** every owner input listed in `docs/templates/target-onboarding.yaml`.

**Phase 5: BLOCKED** on phase 4 and on deployment-provider access. The ten acceptance cases are in
`docs/target-onboarding.md` §3.

**Phase 6: BLOCKED.** It needs:
- the required profile list;
- Firefox and WebKit binaries;
- native devices;
- target baselines approved by the owner.

**Phase 7: BLOCKED.** It needs the intended runner, database, storage and deployment environment.
Recovery behaviour is covered only against local PostgreSQL 16.

**Phase 8: BLOCKED.** It needs:
- representative labelled target decisions;
- held-out episodes;
- current provider evidence.

Unqualified profiles stay in shadow mode.

**Phase 9: done for the available scope** (this report, §5).
