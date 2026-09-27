# Requirement map (initial)

Requirement → approved scenario → assertions. Generated coverage graphs arrive
in Phase 6; until then this table is maintained by hand and checked by
`qa validate` (every scenario must name at least one requirement).

| Requirement | Description | Scenario(s) | Key assertions |
| --- | --- | --- | --- |
| AUTH-01 | Customer signs in with valid credentials | `sign_in` | url_path `/products`, current user shown |
| AUTHZ-01 | Viewer role cannot create notes | `viewer_cannot_create_notes` | read-only notice, no Add note button, note delta 0 |
| CHECKOUT-01 | Existing customer places the fixture order | `checkout_existing_customer`, `checkout_exploration` | confirmation visible and persists, exactly one new order, no console errors |
| CHECKOUT-02 | Charged total equals business-rule total | `checkout_existing_customer` | integer minor units from fixture, displayed total |
| CHECKOUT-03 | Empty address is rejected without mutation | `checkout_rejects_empty_address` | error text, order delta 0, submit still present |
| NOTES-01 | Customer creates a note | `notes_crud` | flash, title shown, note delta 1 |
| NOTES-02 | Customer deletes a note via confirmation | `notes_crud` | empty state, note delta 0, persists after reload |
| SETTINGS-01 | Theme preference persists | `settings_preference_persists` | saved status, value after save and after fresh navigation |
