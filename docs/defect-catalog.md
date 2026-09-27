# Seeded defect catalog

Each defect in `fixtures/test-app/src/defects.ts` violates at least one approved
requirement. `tests/e2e/regression.test.ts` asserts that the owning scenario
fails with the listed reason and that the release gate is held, and that the
catalog and the detection matrix stay in sync.

| Defect | Violated requirement | Detecting scenario | Expected result |
| --- | --- | --- | --- |
| `checkout_double_submit` | CHECKOUT-01 exactly one order | `checkout_existing_customer` | FAIL `assertion_failed` (order_count_delta) |
| `total_off_by_one` | CHECKOUT-02 total in minor units | `checkout_existing_customer` | FAIL `assertion_failed` (order_total_minor_units, ui_text) |
| `validation_bypass` | CHECKOUT-03 empty address rejected, no mutation | `checkout_rejects_empty_address` | FAIL `assertion_failed` |
| `confirmation_missing` | CHECKOUT-01 confirmation shown | `checkout_existing_customer` | FAIL `assertion_failed` (ui_visible) |
| `note_delete_ignored` | NOTES-02 delete persists | `notes_crud` | FAIL `assertion_failed` |
| `role_escalation` | AUTHZ-01 viewer is read-only | `viewer_cannot_create_notes` | FAIL `assertion_failed` |
| `preference_not_persisted` | SETTINGS-01 preference survives reload | `settings_preference_persists` | FAIL `assertion_failed` |
| `ambiguous_checkout_labels` | CHECKOUT-01 prescribed control exists | `checkout_existing_customer` | FAIL `step_target_unavailable`; exploration abstains or is denied |
| `cart_console_error` | CHECKOUT-01 no script errors | `checkout_existing_customer` | FAIL `assertion_failed` (no_console_errors) |
| `checkout_button_disabled` | CHECKOUT-01 control actionable | `checkout_existing_customer` | FAIL `step_target_unavailable` |

Enable defects with `FIXTURE_DEFECTS=a,b` (standalone app), `qa demo --defects a,b`,
or `PUT /__qa/defects` on a running fixture app.
