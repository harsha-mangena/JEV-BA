# Capability matrix

What the platform can currently execute and verify. Anything marked
unsupported is reported as `BLOCKED unsupported_capability` or excluded from
coverage — never silently passed.

| Capability | Regression runner | Exploration (S1) | Notes |
| --- | --- | --- | --- |
| Chromium desktop 1280×800 | ✅ | ✅ | Pinned Playwright 1.56.1 |
| Chromium mobile viewport 390×844 | ✅ | ✅ | Viewport emulation only; not native-device evidence |
| Firefox / WebKit | ❌ | ❌ | Phase 9 |
| Click (actionability-checked, no `force`) | ✅ | ✅ | Trial pass before dispatch separates "not dispatched" from "effect unknown" |
| Type / fill | ✅ | ✅ | Values from fixture refs; secrets resolved only at dispatch |
| Select option | ✅ | ❌ | Not enabled for exploration until capability tests exist |
| Navigate / reload | ✅ | — | |
| Scroll, keyboard, upload, drag | ❌ | ❌ | |
| iframes, shadow DOM | ❌ | ❌ (counted in coverage) | Reported via `coverage.unsupported_frames` / `shadow_roots_skipped` |
| Canvas interaction | ❌ | ❌ | Out of scope for the first release |
| UI assertions (visible/hidden/text/url) | ✅ | ✅ | Strict: ambiguous locators fail |
| Backend assertions (order/note count delta, integer totals) | ✅ | ✅ | Through the fixture service, independent of the UI |
| Persistence after reload | ✅ | ✅ | |
| Console-error assertion | ✅ | ✅ | |
| Origin allow-list | ✅ | ✅ | Off-origin requests aborted and logged; main-frame navigation off-origin → BLOCKED |
| Revision check (expected SHA) | ✅ | ✅ | Before and after the run; drift → SUPERSEDED |
| Visual baselines, axe accessibility, keyboard journeys | ❌ | ❌ | Phase 5 |
| Deployment webhooks, status publishing | ❌ | ❌ | Phase 4 (envelope/dedup contracts exist) |
| Live S1 / S2 providers | — | ❌ | Interfaces and offline fakes only |
