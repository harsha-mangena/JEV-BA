# Evaluations and calibration (Phase 8)

```
exploration runs ──► qa evals extract ──► labels.jsonl (annotate) ──► qa calibrate ──► evals/registry/<id>.json
                                                                        │
                                          gate stage 5 uses it only for the exact decision configuration
```

## Labeling

`qa evals extract --run <dir>... --app <id> --decision-config decision-config.json --labels out.jsonl`
exports every S1 decision (features, distributions, config) with an empty
label. Label the **complete action**: operation, target, parameter, policy
compatibility and milestone. Categories (`packages/calibration/src/labels.ts`):

| Category | Meaning | Used for fitting |
| --- | --- | --- |
| `correct` | A valid next action (list others in `valid_alternatives`) | yes (positive) |
| `wrong_operation`, `wrong_target`, `wrong_parameter`, `policy_incompatible`, `wrong_milestone` | Model error | yes (negative) |
| `correct_target_absent`, `unsupported_control` | Observation/extraction failure | no — reported as observation failure rate; still errors at evaluation |
| `insufficient_evidence` | Nobody could decide from the observation | yes (negative: acting would have been a guess) |

Keep every annotator's label in `annotations`; `agreement()` reports unanimity.

## Calibration

`qa calibrate --labels labels.jsonl --target 0.99 [--registry evals/registry]`

- **Grouped splits** by (app, journey, deployment): fit 50%, threshold
  selection 25%, held-out test 25%. Adjacent steps never straddle partitions.
- **Calibrator**: L2 logistic regression over named gate features
  (`FEATURE_NAMES`), deterministic.
- **Threshold**: the lowest score whose one-sided exact (Clopper–Pearson)
  lower bound on the *selection* split meets the target. If none does, the
  calibration has no threshold and the gate stays heuristic/advisory.
- **Report** (held-out only): Act-band precision with exact lower bound and a
  cluster-bootstrap 5th percentile, coverage, Brier, ECE, reliability bins,
  risk–coverage curve, per-cohort (risk class × operation) support, and
  observation failure rate.
- **Cohorts** whose held-out lower bound misses the target are unsupported:
  the gate escalates or abstains there instead of acting.

Useful arithmetic (asserted in tests): zero errors in *n* independent accepted
actions give a 95% lower bound of `0.05^(1/n)` — 98.51% at 200, 99.40% at 500;
99% needs 299 error-free actions, 99.9% needs 2,995. A 99%-per-step model
completes a 50-step journey only ≈60.5% of the time. Measure journeys directly.

## Pinning and drift

A calibration applies only when the decision-configuration digest (model,
question schema, extractor, policy, candidate filter, gate version) matches
exactly; otherwise the gate records `calibration_config_mismatch` and routes
heuristically. `qa evals canary --labels candidate.jsonl` compares a new
configuration's labeled replay against the current calibration and fails on a
configuration change, a precision-bound drop or an ECE rise.

## Comparative experiments

`summarizeArm()` compares arms (deterministic suite, S2-only, S1 heuristic, S1
calibrated, hybrid) on identical fixtures and seeded defects: defect recall,
false positives, **false passes**, p50/p95 case time, cost per verified journey
and human review load. Provider prices are not hard-coded.
