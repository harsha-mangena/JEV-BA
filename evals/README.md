# Evaluations

Reserved for Phase 8: labeled observations, held-out journeys, grouped
splits, calibrator/threshold registry, risk–coverage reports and drift tools.

Rules that already apply to anything added here:

- Label complete action correctness (operation, target, parameter, policy
  compatibility, milestone), allow several valid next actions, and mark
  "correct target absent", "insufficient evidence" and "unsupported control"
  separately.
- Split by application / journey / deployment, never randomly across adjacent
  steps of one recording. Keep threshold-selection data apart from final
  evaluation data.
- Report sample counts and uncertainty with every precision figure. A pooled
  step-level number is not a journey-level reliability claim.

Decision records emitted by the exploration driver (`events.jsonl`, kind
`decision`) already carry the fields a labeling tool needs: observation id,
model ids, question and candidate hashes, raw distributions, gate features and
outcome.
