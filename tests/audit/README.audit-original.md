# Independent JEV-BA audit probes

Reviewed commit: cb83f85b94be7080d577580d2038d44a9cbc9074.

These tests assert the required safe behavior. At the reviewed revision all
13 assertions fail, exposing eight issue groups. They are intentionally kept
separate from the repository's original test suites. Production code was not
modified. See JEV_BA_Implementation_Audit.md for impact, limitations and fixes.

## Run

Check out the reviewed repository revision, then copy this audit/ directory
into the repository root. Run these commands from that root:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:e2e
npx vitest run --config audit/vitest.config.ts
```

Node >=22 and Python 3 are required. The audit suite requires no API key or
database. It starts disposable local fixture applications and a local HTTP
server, opens Chromium, runs a generated Playwright spec, and scans a locally
generated trace for synthetic credentials without printing those values.

The generated-spec probe writes only its own harmless marker in audit/ and
removes it afterward. F05b uses an explicit database-read double to exercise
the production promotion-gate method; it does not simulate PostgreSQL locking.
Model responses are deterministic local doubles. No live Jev accuracy is measured.

Set a disposable PostgreSQL DATABASE_URL to enable the original repository's
24 service tests. Without it, those tests skip. The live provider test also
skips unless its required provider settings/credentials are supplied.

## Expected findings

| Probe | Finding |
| --- | --- |
| F01a/F01b | TypeSafe request map and Noul decoding mismatch |
| F02a/F02b | Regression/exploration mutation permissions bypassed |
| F03 | Generated spec can write outside its work directory |
| F04a/F04b/F04c | Calibration mismatch, unqualified fallback and resolved-model drift |
| F05/F05b | Profile changes leave suite hash and old gate eligibility unchanged |
| F06 | Trace archive retains synthetic session credential |
| F07 | Image-capable S2 receives no screenshot |
| F08 | Caller signal disables the configured request timeout |

The evidence archive excludes raw browser traces, actual credentials,
node_modules and repository implementation files.
