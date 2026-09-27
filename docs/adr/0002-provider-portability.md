# ADR 0002 — Provider-neutral S1/S2 adapters

Status: accepted

## Decision

- `SystemOneProvider` and `SystemTwoProvider` are our interfaces, not a vendor's
  wire format. Scenario contracts never name a provider or model.
- Every decision records the requested and resolved model, the question-schema
  hash, the candidate-set hash, the raw distributions, the gate configuration
  version and the calibration version (currently `null`).
- Response validation rejects — never repairs — non-finite or out-of-range
  probabilities, sums outside `1e-3`, unknown or missing keys, and a selected
  option that is not maximal (genuine ties are allowed through to the gate).
- An alternative provider is acceptable only if it passes the same validation,
  exploration and (later) calibration suites. "System One" is a role, not a
  guarantee of interchangeable behaviour.

## Consequences

The TypeSafe/Jev adapter is a thin mapping to be written once the live contract
can be exercised; nothing else depends on its wire format.
