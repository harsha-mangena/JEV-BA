# Requirement map (initial)

Requirement → approved scenario → assertions. Generated coverage graphs arrive
in Phase 6; until then this table is maintained by hand and checked by
`qa validate` (every scenario must name at least one requirement).

| Requirement | Description | Scenario(s) | Key assertions |
| --- | --- | --- | --- |
| AUTH-01 | Customer signs in with valid credentials | `sign_in`, `production_smoke` | url_path `/products`, current user shown; sign-in page available (read-only) |
| AUTHZ-01 | Viewer role cannot create notes | `viewer_cannot_create_notes` | read-only notice, no Add note button, note delta 0 |
| CHECKOUT-01 | Existing customer places the fixture order | `checkout_existing_customer`, `checkout_exploration` | confirmation visible and persists, exactly one new order, no console errors |
| CHECKOUT-02 | Charged total equals business-rule total | `checkout_existing_customer` | integer minor units from fixture, displayed total |
| CHECKOUT-03 | Empty address is rejected without mutation | `checkout_rejects_empty_address` | error text, order delta 0, submit still present |
| NOTES-01 | Customer creates a note | `notes_crud` | flash, title shown, note delta 1 |
| NOTES-02 | Customer deletes a note via confirmation | `notes_crud` | empty state, note delta 0, persists after reload |
| SETTINGS-01 | Theme preference persists | `settings_preference_persists` | saved status, value after save and after fresh navigation |
| UX-01 | Cart renders without layout defects or unapproved visual change | `cart_quality` | layout_sound, visual_match |
| A11Y-01 | Cart has no serious automatically detectable violations | `cart_quality` | a11y_scan |
| A11Y-02 | Keyboard-only checkout with visible focus | `keyboard_checkout` | focused, focus_visible, order delta 1 |

The machine-readable graph is `specs/coverage.yaml` (Phase 6).
