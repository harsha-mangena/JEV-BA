# ADR 0001 — The controller is the only authority

Status: accepted

## Context

S1 and S2 models can be confidently wrong, can be steered by page text, and do
not know what a control does. A probability is not a permission.

## Decision

- Models have no credentials, shell, browser channel or network access of their
  own. They receive serialized observations (page text marked as untrusted
  data) and return typed proposals only.
- The gate evaluates stages in a fixed order: identity/budget/schema →
  permission → parameter and coverage → freshness/actionability → uncertainty.
  A later stage cannot override an earlier one.
- Permission derives from trusted configuration only: the project policy's
  mutation bindings and control bindings, and the scenario's policy. An unbound
  control has *unknown* risk and is denied unless the scenario opts into
  read-only exploration.
- S2 selections re-enter permission and freshness checks and are logged as
  `s2_selected_uncalibrated`; they never convert S1 uncertainty into certainty.
- DONE triggers verification; only approved assertions decide a milestone.
- Secrets are resolved by the executor at dispatch time only. Evidence is
  redacted before it is written; traces are disabled for scenarios that type
  secrets.

## Consequences

Adding a new effectful control requires a reviewed binding in
`specs/policies/*.yaml`. Exploration on an unconfigured application will mostly
abstain or be denied, which is the intended failure mode.
