# Source and version register

| Item | Version / reference | Why pinned |
| --- | --- | --- |
| Node.js | 22 (`.nvmrc`) | Runtime |
| `@playwright/test` | 1.56.1 (Chromium revision 1194) | Browser binary, rendering and actionability semantics |
| `zod` | ^3.24 | Contract schemas |
| `yaml` | ^2.6 | Scenario/policy parsing |
| `vitest` | ^3.2 | Unit and e2e test runner |
| Gate configuration | `heuristic-v0` (0.8 op, 0.8 target, 0.2 margin) | Experimental routing only; no calibration version exists |

Research sources are listed in `docs/implementation-plan.md` §15. The
TypeSafe documentation (S1–S6) could not be reached from the build
environment; nothing in this codebase depends on unverified details of its
API.
