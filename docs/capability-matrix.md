# Capability matrix

What the platform executes and verifies. Unsupported capabilities are reported
as `BLOCKED unsupported_capability` or excluded with a reason — never silently
passed.

| Capability | Regression | Exploration (S1) | Notes |
| --- | --- | --- | --- |
| Chromium desktop / mobile viewport | ✅ | ✅ | Pinned Playwright 1.56.1; viewport emulation is not native-device evidence |
| Firefox / WebKit desktop | ✅ when installed | ✅ when installed | Missing browser → BLOCKED |
| Click, type, select, navigate, reload | ✅ | click/type | Actionability-checked; never `force`; trial pass separates not-dispatched from effect-unknown |
| Keyboard (`press`) | ✅ | ❌ | Tab/Shift+Tab/Enter/Space/Escape/arrows |
| Scroll, upload, drag, canvas | ❌ | ❌ | Out of scope |
| iframes, shadow DOM | ❌ | ❌ | Counted in observation coverage |
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
| Live S1 providers | — | TypeSafe (unverified format), neutral HTTP | Probe before enabling |
| Calibrated autonomy | — | after `qa calibrate` | Exact decision configuration, supported cohorts only |
