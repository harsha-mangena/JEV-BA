# Fourth review closure (P4a–P4c)

This report responds to the independent review of merged PR #4, revision
`333f23ce5e66a007dffd7a78d5db5f3fcf056922`. The work is on branch
`claude/new-session-lnwzm0`.

**Status.** The three new boundary findings are fixed, and the previous six probes still pass. This
is **not** a qualified platform for a real application. Live providers, real deployment enforcement
and target qualification remain unverified (§4). Evidence is reported at the same four levels as
before:
- mechanism;
- fixture proof;
- authenticated-provider proof;
- target qualification.

## 1. Findings

### P4a: page CSS could defeat the screenshot privacy verification (P1)

**Cause.** The verifier hid sensitive content with an injected attribute-selector
`visibility:hidden!important` rule. It then compared the result with an ordinary capture. An author
rule with higher specificity won the cascade, for example
`#value::before{visibility:visible!important}`. The "hidden" capture still showed the secret, both
captures matched, and the leaking image was approved.

**Fix.** Suppression is now made hard to override, and it is never assumed. It is checked.

- **Suppression.**
  - Every marked element's whole flat subtree is covered: light descendants and open shadow trees.
  - Each element gets an inline `visibility:hidden!important`. The page's own inline style is kept
    and restored through the CSSOM.
  - Each tree scope gets a stylesheet, prepended so that its rules sit in the *first-declared*
    cascade layer. For `!important` declarations, an earlier layer beats every later layer and all
    unlayered author rules. This covers the element, the descendants and the painting
    pseudo-elements: `::before`, `::after`, `::marker`, `::first-letter`, `::first-line`,
    `::placeholder` and `::file-selector-button`.
  - The same rules are also added as a constructed stylesheet. A CSP that blocks injected `<style>`
    elements does not block that, and this was confirmed in Chromium.
  - Transitions and animations are switched off for the suppressed elements.
- **Verification.** It runs immediately before and immediately after the capture.
  - Every suppressed element and painting pseudo-element must compute `visibility: hidden`.
  - Nothing new may appear inside a marked subtree.
  - Closed and user-agent shadow trees are checked through the DevTools protocol (Chromium).
    Rules inside such a tree beat the page's `!important`, so a hidden host does not imply hidden
    content. In a browser without the protocol, a suppressed subtree that may hold such content is
    reported as unverifiable.
  - During the capture, a mutation watch reports any change to the suppressed subtrees, any
    attribute change on their ancestors, and any removal of the suppression stylesheet.
  - Anything unverified is retried twice more. After that the image is withheld with the reason.
- **Screenshot call.** Playwright's `caret: 'hide'` rewrites the `style` attribute of form controls
  in the middle of the capture. For the suppressed capture, the caret is hidden by our own sheet
  instead.

### P4b: the tolerance accepted recoverable secret pixels (P1)

**Cause.** Pixel differences of 12 channel levels or less were ignored as rasterization noise. Text
in `rgb(245,245,245)` on white fell inside that budget.

**Fix.** No tolerance is involved any more. The paired comparison is gone: the published image *is*
the capture taken while sensitive paint was verified suppressed. Low-contrast, translucent,
overflowing or positioned sensitive glyphs are therefore absent from it, not judged small enough.
The masks remain as visible redaction markers. The unused `pngjs` dependency of `@qa/browser` was
removed.

### P4c: an ordinary directory was accepted as an enforced cgroup (P2)

**Cause.**
- The cgroup version was inferred from whether `cgroup.controllers` existed.
- Control files were written with ordinary `writeFile`, which creates missing files.
- Nothing was read back, and membership was never checked.

**Fix.** `createSandboxCgroup` no longer assumes anything from a path.
- **Filesystem.** `statfs` must report the cgroup filesystem: `0x27e0eb` for v1 or `0x63677270` for
  v2. This applies to the parent and to the new child.
- **v2.** The parent must have `cgroup.controllers`, and `memory` (and `pids`, when a process cap is
  requested) must be in its `cgroup.subtree_control`.
- **v1.** The parent must be in the memory hierarchy.
- **Control files.** They must have been created by the kernel. They are opened without `O_CREAT`.
- **Read-back.** `memory.max` / `memory.limit_in_bytes` must read back as requested, to within a
  page. `memory.swap.max` must read back `0` where it exists. `pids.max` must read back as
  requested.
- **Membership.** `join` writes the PID, then requires it in the cgroup's `cgroup.procs` *and* in
  `/proc/<pid>/cgroup` for every hierarchy used. Only then is the sandbox's execution gate released.
  Otherwise the process is killed and the run is `unavailable`.

The valid v1 and v2 paths and the whole-tree OOM tests are unchanged.

## 2. Verification

### Reproduction

The four probes in `tests/audit/reaudit4.test.ts` are part of the mandatory audit lane. They were
rebuilt from the review's description, because its ZIP bundle was not available in this environment.
They use only APIs that existed at the reviewed revision, and they measure leaks the way the review
does: a leak is any pixel that the secret paints (comparing the page with and without it) that is
reproduced exactly in the accepted image.

| Revision | Result | Log |
|---|---|---|
| `333f23c` | Control passes. **P4a** leaked 2,697 glyph pixels, **P4b** leaked 2,784 and **P4c** was accepted as v1: 3 failures, matching the review. | `docs/evidence/reaudit4/probes-at-333f23c.txt` |
| This branch | 4/4 pass. P4a and P4b are accepted with 0 leaked pixels. P4c returns "not on a cgroup filesystem". | `docs/evidence/reaudit4/probes-after-fix.txt` |

### Mandatory tests added

- **`tests/e2e/pixel-privacy.test.ts`**, "suppression cannot be defeated by the page". Each case is
  checked on decoded pixels, with a raw-capture control and a non-sensitive positive control. The
  test also checks that the page is left unchanged afterwards: no marks, no sheets, and the original
  inline style.
  - An ID-specific `!important` rule on a pseudo-element.
  - An inline `!important` on the element.
  - An `!important` rule on a descendant class.
  - `!important` rules in the page's own cascade layer.
  - A visibility transition.
  - Glyphs in `rgb(245,245,245)`.
  - Glyphs at opacity 0.03.
  - A CSP that blocks injected styles.
  - A closed shadow root that re-shows its content. This one is withheld.
- **The same file:** a page that rewrites sensitive content during every capture attempt is
  withheld after exactly three attempts.
- **`tests/isolation/sandbox.test.ts`**, "only a real, delegated kernel cgroup is accepted":
  - an ordinary directory is rejected, and the sandboxed program never runs;
  - a hand-made controller layout is rejected;
  - a real cgroup without the memory controller delegated is rejected;
  - kernel membership is checked before and after joining, the limit reads back, and a process that
    has exited cannot be joined.

The previous tests still pass: the six review-3 probes, N1a/N1b, and the ordinary-content and
fixture-application privacy tests, covering evidence, visual candidates and diffs, and the S2 image.
The privacy tests passed four times in parallel without a failure.

## 3. Evidence levels by area (changes only)

| Area | Mechanism | Fixture proof | Authenticated-provider proof | Target qualification |
|---|---|---|---|---|
| Privacy (R4, N1, P4a, P4b) | implemented | e2e decoded-pixel tests and audit probes | not applicable. S2 is still offline; its request image passes through the same boundary. | none |
| Sandbox memory limit (MEM, P4c) | implemented | isolation lane: cgroup v1 locally, v2 in CI | not applicable | none. A deployment must delegate a kernel cgroup. |

All other rows of `docs/review3-closure.md` §2 are unchanged.

## 4. Not done: external prerequisites and scope

This list is unchanged from the previous report, and none of these items is claimed.
- **Live providers.** Live Jev needs `QA_S1_API_KEY`. Live S2 needs `ANTHROPIC_API_KEY`. Both stay
  BLOCKED and are never counted as passing.
- **A real target application.** It needs its application contract, roles, fixtures, backend
  oracles, effect lookup and cleanup, supplied by the application owner.
- **Deployment enforcement.** An installed event source and promotion consumer must be shown, in the
  real environment, handling:
  - a clean deployment;
  - a defect;
  - a missing result;
  - a stale candidate;
  - an unresolved effect.
  The Docker demo is fixture proof only.
- **Browser coverage.** Firefox and WebKit binaries, and native devices where claimed, are missing.
  Outside Chromium, a suppressed subtree that may hold closed or user-agent shadow content is
  withheld rather than verified.
- **Calibrated autonomy.** It needs representative labelled data, current provider evidence and
  target episodes. Unqualified workers stay in shadow mode.

**Residual limit.** A page script that briefly rewrites a stylesheet through the CSSOM, without any
DOM mutation, *within* the capture window and restores it before the second verification is outside
this threat model. Author styles, ordinary page activity and CSP are covered.

## 5. Lanes on the final commit

LANES_PLACEHOLDER
