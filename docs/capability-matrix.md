# Capability matrix

What the platform executes and verifies. Unsupported capabilities are reported
as `BLOCKED unsupported_capability` or excluded with a reason — never silently
passed.

| Capability | Regression | Exploration (S1) | Notes |
| --- | --- | --- | --- |
| Chromium desktop / mobile viewport | ✅ | ✅ | Pinned Playwright 1.56.1; viewport emulation is not native-device evidence |
| Firefox / WebKit desktop | ✅ when installed | ✅ when installed | Missing browser → BLOCKED |
| Click, type, select, navigate, reload | ✅ | click/type/select | Prepared (no input), authorized against the application contract, then dispatched once; SELECT in exploration uses a page-offered option and only in heuristic staging |
| Keyboard (`press`) | ✅ | ❌ | Tab/Shift+Tab/Enter/Space/Escape/arrows |
| Scroll | — | ✅ | Effect-free, budgeted, loop-detected |
| Upload, drag, canvas | ❌ | ❌ | Out of scope |
| Open shadow DOM | ✅ (Playwright locators) | ✅ | Extracted and actionable; closed roots are invisible by design |
| iframes | ❌ | ❌ | Counted in coverage; a decision blocked by frame-only content ends `unsupported_capability` |
| UI assertions (visible/hidden/text/url/focus) | ✅ | ✅ | Strict: ambiguous locators fail |
| Backend oracles (entity deltas, integer totals) | ✅ | ✅ | Via the fixture service; unavailable in read-only profile |
| Visual baselines | ✅ | — | Per scenario/checkpoint/profile/rendering profile; explicit approval |
| Layout geometry | ✅ | — | Overflow, overlap, obscured, clipped |
| Automated accessibility (axe) | ✅ | — | Not a full accessibility audit |
| Origin allow-list, revision checks | ✅ | ✅ | Before and after runs |
| Deployment triggers | GitHub webhook/workflow, Vercel webhook/dispatch, pipeline, manual | | |
| Status publishing | GitHub commit status, Vercel deployment check | | |
| Change-aware selection | ✅ | ✅ | Broadens on any uncertainty |
| Read-only production profile | ✅ | disabled | Fixture-less, non-mutating, read-only controls only |
| Live S1 providers | — | TypeSafe/Jev (published questions-map contract; live probe required), neutral HTTP | Bounded transport; `qa s1 probe` writes a compatibility record |
| System Two | — | Claude vision (`QA_S2_PROVIDER=anthropic`) | Masked screenshots; context requests fulfilled; proposals re-gated |
| Effect authorization | ✅ | ✅ | Trusted application contract (intents, routes, scoped control bindings); unknown effects denied |
| Durable intents and reconciliation | ✅ | ✅ | PREPARED/DISPATCHING persisted before input; keyed effects reconciled from the application after crashes |
| Generated-spec validation | ✅ (namespace sandbox) | — | Linux user namespaces required; no host fallback |
| Autonomy modes | — | shadow (default), heuristic staging, calibrated | Calibrated only for a qualified profile (`qa qualify`); otherwise shadow |
