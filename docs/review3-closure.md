# Third review closure (N1–N3 and resource limits)

This report responds to the third independent review, which covered revision
`c70d0ef28c9a0d2073b7defc9fd734812a82ae90` (the merge of PR #3). The work is on branch
`claude/new-session-lnwzm0`.

The lane manifests for the final commit are in `docs/evidence/review3-lanes/`, and §4 lists what
they show.

> **Superseded in part by the fourth review** ([`review4-closure.md`](review4-closure.md)). The N1 check that
> compared two captures within a rasterization tolerance could be defeated by page CSS (P4a) and accepted
> low-contrast secret glyphs (P4b); it has been replaced by verified suppression. The memory-limit cgroup
> factory accepted an ordinary directory (P4c); it now validates the kernel hierarchy. N2 and N3 stand.

**Status.** The review's three residual code findings are fixed, and the sandbox now enforces a
memory limit. This is still not a qualified autonomous-testing platform for a real application.
Every item below is reported at four separate evidence levels, and no level is inferred from the
one before it:

| Level | What it means |
|---|---|
| **Mechanism** | The code path exists and is exercised by offline tests. |
| **Fixture proof** | It was demonstrated against the controlled fixture application. |
| **Authenticated-provider proof** | It was verified against the live provider: Jev, Anthropic, GitHub or Vercel. |
| **Target qualification** | It was verified on a real application and a real deployment integration. |

The same levels are recorded per item in `docs/acceptance-inventory.json`, under each item's
`levels` field.

## 1. Findings

### N2: in-process retries bypassed the obligation hold (P1)

**Cause.** Inside `runSuite`, an attempt ending `NEEDS_REVIEW/effect_unreconciled` was retried
with a fresh fixture, because every attempt used its own in-memory intent store. For a
noncritical case, the retry's `FLAKY` result then opened the standalone gate.

**Fix.**
- One intent store now covers the whole logical execution, and each case's open obligations are
  checked before every attempt.
- The new `IntentStore.openFor(scenario, profile)` includes the execution's own earlier attempts.
  The PostgreSQL store also includes the current job and excludes other jobs still in progress.
- A case with an unresolved effect is never dispatched again, on any fixture. It ends
  `NEEDS_REVIEW`, keeps its first-attempt evidence, and says why it was not retried.
- Every open obligation is a reason in the standalone gate, whatever the critical or flaky policy
  says. The CLI's exit code follows that gate.
- An ordinary retry after an assertion failure still follows its declared policy. Settled effects
  are not obligations.

**Verification.**
- **Probes N2a and N2b** use the critical and noncritical variants. At `c70d0ef` both dispatched
  a second checkout, and the noncritical gate was eligible. They now show one dispatch and a held
  gate.
- **`tests/e2e/retry-obligations.test.ts`** uses a real browser and the fixture application. It
  covers:
  - a lookup timeout after a real checkout, with a noncritical case and 2 retries: one fixture,
    one dispatch, gate held;
  - cancellation while a checkout is in flight;
  - an ordinary assertion-only retry.
- **`tests/service/obligations.test.ts`** runs the same suite through the PostgreSQL service worker
  with 2 retries, where the adapter's lookup times out. It shows one dispatch, a `NEEDS_REVIEW`
  case, a held gate, and the obligation listed.

### N1: rendered secret pixels escaped the mask (P1)

**Cause.** Detection read only text and form values, so CSS generated content was missed. Masking
covered only element boxes, so overflowing glyphs stayed visible. The post-capture check was a
second DOM scan with the same blind spots.

**Fix.**
- **Detection.** It now includes the resolved `content` of `::before`, `::after` and `::marker`
  (with `attr()` values resolved), and any attribute feeding that content.
- **Masking.** Opaque overlays are placed as children of each marked element, so they move with it.
  They cover the element's border box, every text line box and every descendant box. Replaced
  elements, SVG and shadow hosts are masked by their box.
- **Verification on pixels.** The page is captured a second time with every marked element made
  invisible, including its descendants and generated content; the masks stay. Any pixel that
  differs beyond rasterization noise is sensitive paint outside a mask, and the image is withheld.
  This also covers paint the detector cannot know about, such as text shadows, transforms and
  positioned content.
- **Settling pages.** A real leak is deterministic, so a mismatch is re-checked on up to three
  fresh pairs of captures before the image is withheld. Without that, a page still settling caused
  false withholds.

**Verification.**
- **Probes N1a and N1b** cover generated content and overflow, with a positive control. At
  `c70d0ef` both were accepted with 639 and 526 visible glyph pixels. Both are now masked, with
  0 glyph pixels.
- **`tests/e2e/pixel-privacy.test.ts`** decodes pixels for these cases, each masked or withheld,
  with positive and unmasked controls:
  - `::after` literal content;
  - a positioned descendant 400 px away;
  - a rotated ancestor;
  - a 420 px text-shadow.
- **Full export paths.** A fixture secret shown as generated content, and as overflowing text,
  goes through evidence screenshots, visual candidates and diffs, and the S2 request image. The
  test is stable under 6 parallel runs.

### N3: revocation did not reach a running shard (P2)

**Cause.** The worker copied only the expiry into the gate, so a revocation was seen only when a
shard obtained a new grant.

**Fix.**
- The calibrated gate carries a live authorization bound to the qualification's id, and it checks
  it immediately before every calibrated action. The registry must return that same
  qualification: not revoked, not expired, and readable.
- Any other answer, or an error, routes the decision with reason `qualification_not_current`.
- A renewal of the same qualification reaches the running shard, and other profiles are
  unaffected.

**Verification.**
- **Probe N3:** `ACT` before revocation, `ESCALATE` after.
- **`packages/orchestrator/test/qualification-runtime.test.ts`** covers:
  - revocation after the first action;
  - a revocation racing 8 concurrent decisions;
  - an unreadable registry;
  - expiry mid-shard, and renewal;
  - an unaffected second profile.

### Resource limits: sandbox memory (original plan requirement)

**Before.** The namespace sandbox bounded processes, files, time and network, but not memory.

**Fix.**
- With `limits.memoryBytes`, the whole sandboxed process tree runs in its own control group, with
  that memory limit, no swap and a process cap. Both cgroup v2 and the v1 memory/pids hierarchies
  are supported.
- A gate holds the program until it has been moved into the cgroup, so nothing runs outside the
  limit.
- An OOM kill is reported as `exceeded: 'memory'`. Afterwards the cgroup is killed and removed.
- If no cgroup can be created or joined, nothing runs; there is no fallback.

**Configuration.**
- Generated-spec validation always sets a limit: 2 GiB by default, or `QA_SANDBOX_MEMORY_MB`.
- `QA_SANDBOX_CGROUP` names the delegated parent cgroup.
- `QA_SANDBOX_CGROUP_SUDO=1` lets the one move into that cgroup go through `sudo -n tee`.
- CI delegates a cgroup v2 parent to the runner.

**Verification.** Isolation tests cover four cases:
- a program over its limit is killed and reported;
- the limit covers the program's descendants;
- a program within its limit runs normally;
- an unenforceable limit runs nothing.

The compiled-spec e2e test also runs under the 2 GiB limit. Both have been run locally on
cgroup v1 and in CI on cgroup v2.

### Reproduction

`tests/audit/reaudit3.test.ts` is now part of the mandatory audit lane. It uses only APIs that
existed at the reviewed revision.

| Revision | Result | Log |
|---|---|---|
| `c70d0ef` | 5 assertion failures and 1 positive control passing, matching the review exactly | `docs/evidence/reaudit3/probes-at-c70d0ef.txt` |
| This branch | 6/6 pass | `docs/evidence/reaudit3/probes-after-fix.txt` |

The review's own `review-audit/` bundle was not available in this environment, so these probes
were rebuilt from the report's description. Their assertions are no weaker than the report's.

## 2. Evidence levels by area

| Area | Mechanism | Fixture proof | Authenticated-provider proof | Target qualification |
|---|---|---|---|---|
| Effect authorization (F02) | implemented | e2e and audit | not applicable | none |
| Durable execution, obligations and retries (F09, R1, N2) | implemented | PostgreSQL process-kill tests, e2e retries, Docker demo hold | not applicable | none |
| Execution contract and lineage (F05, R2, R3) | implemented | PostgreSQL tests; the demo promotes clean, holds a defect and a stale candidate | none: GitHub and Vercel only against local fakes | none: no real deployment controller |
| Privacy and isolation (F03, F06, R4, N1, memory) | implemented | e2e pixel tests, isolation lane | not applicable | none |
| Jev transport (F01, F08) | implemented | offline wire-format and timeout tests | **BLOCKED**: `QA_S1_API_KEY` | none |
| Vision S2 (F07) | implemented | offline, stubbed provider; masked request image | **BLOCKED**: `ANTHROPIC_API_KEY` | none |
| Autonomy and qualification (F04, R5, N3, phase 11) | implemented | unit tests only | **BLOCKED**: no live compatibility record | **BLOCKED**: no representative labelled data or target episodes; nothing is qualified, and workers run in shadow mode |
| Browsers and capabilities (F10, phase 8) | implemented | Chromium desktop and mobile viewport | not applicable | none. Firefox and WebKit are BLOCKED without their binaries. Viewport emulation is not native-device testing. Iframe extraction is unsupported. |
| Operations (phase 10) | implemented | Docker demo in CI | not applicable | none: no real target onboarding |

## 3. Not done: external prerequisites and scope

- **Live Jev.** The live lane needs `QA_S1_API_KEY`. It stays BLOCKED, is never counted as
  passing, and would record the resolved model identity.
- **Live S2.** The `live_s2` lane needs `ANTHROPIC_API_KEY`, with permitted synthetic data.
- **A real target application.** It needs its application contract, fixtures and roles, backend
  oracles, keyed effect lookup for each mutation to be reconciled, and cleanup rules. All current
  evidence is fixture-only.
- **Deployment-triggered enforcement.** A real deployment event source and a promotion consumer
  must be installed and tested. The consumer promotes only the deployment, channel and generation
  that the consume call returns. The run must show a clean promotion, plus holds for a defect, a
  missing result, a stale candidate and an unresolved effect, in the real environment. The Docker
  demo shows this flow against the fixture only.
- **Browser coverage.** Every declared profile needs qualifying: Firefox and WebKit binaries, and
  native devices where claimed.
- **Calibrated autonomy.** It needs representative labelled target decisions, current live
  compatibility evidence, and target episodes. Unqualified profiles stay in shadow mode.
- **Memory-limit deployment.** Deployments that validate generated specs must delegate a cgroup
  (`QA_SANDBOX_CGROUP`). Without one, validation returns `error` rather than running.

## 4. Lanes on the final commit

These lanes ran on commit `b755a41` with a clean tree. The manifests are in
`docs/evidence/review3-lanes/`: every manifest records `dirty: false`, and each one lists its
failures, its skips (none) and any missing prerequisite. GitHub CI ran the same lanes on the same
commit, with a delegated cgroup v2, and they passed there too.

| Lane | Command | Result |
|---|---|---|
| static | `npm run lane -- static` | PASSED |
| unit | `npm run lane -- unit` | 189/189, 0 failed, 0 skipped |
| e2e | `npm run lane -- e2e` | 88/88, 0 failed, 0 skipped |
| service | `QA_REQUIRE_SERVICE=1 DATABASE_URL=… npm run lane -- service` | 49/49, 0 failed, 0 skipped (PostgreSQL 16) |
| audit | `npm run lane -- audit` | 26/26: 13 original probes, 7 re-audit probes and 6 third-review probes |
| isolation | `npm run lane -- isolation` | 12/12, including 4 memory-limit tests (cgroup v1 locally, v2 in CI) |
| live | `npm run lane -- live` | **BLOCKED**: missing `QA_S1_API_KEY`. It was not run and is not counted as passing. |
| live_s2 | `npm run lane -- live_s2` | **BLOCKED**: missing `ANTHROPIC_API_KEY`. It was not run and is not counted as passing. |
| spec validation | `npm run qa -- validate` | all scenarios ok |
| deployment flow | `docker build -t jev-ba/qa:local . && node deploy/demo/run-demo.mjs --out docs/evidence/review3-demo` | PASSED |

The deployment flow ran against the fixture, and passed all three steps:

1. The clean deployment was promoted once.
2. The defective deployment was held and its promotion refused.
3. The run whose worker was SIGKILLed held its gate on an unverifiable effect of the dead worker
   (`notes.create`, `NEEDS_REVIEW`). After an admin adjudicated it and the run was retried, the
   deployment promoted.

This is fixture proof only. It does not establish an installed, real-world deployment gate.
