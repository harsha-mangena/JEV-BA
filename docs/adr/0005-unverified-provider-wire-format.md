# ADR 0005 — Ship the TypeSafe adapter behind a probe, not a guess

Status: accepted

The provider documentation (docs.typesafe.ai and mirrors) was unreachable from
the build environment. Public descriptions establish the semantics (state plus
typed questions; Choice returns per-option probabilities and a confidence;
Noul returns a probability; ≤255 Choice options) but not exact field names.

Decision: implement `TypeSafeProvider` from those semantics with a tolerant
decoder, mark it `WIRE_FORMAT_VERIFIED = false`, and require
`qa s1 probe` / `npm run test:live` to pass before enabling exploration.
Because every response goes through strict validation, a mismatch produces
invalid heads and an abstention — it cannot produce an action or a PASS.
When the live contract is confirmed, update the codec and flip the flag.
