/**
 * Switchable seeded defects (see docs/defect-catalog.md). Each one violates at
 * least one approved expectation in specs/scenarios, so the runner's ability to
 * detect it is independently demonstrable.
 */
export const DEFECTS = {
  checkout_double_submit: 'Placing an order persists two orders.',
  total_off_by_one: 'Persisted order total is one minor unit higher than the cart total.',
  validation_bypass: 'An empty delivery address is accepted and an order is created.',
  confirmation_missing: 'Order is persisted but the confirmation view is not shown.',
  note_delete_ignored: 'Confirming a note deletion leaves the note in place.',
  role_escalation: 'The read-only viewer role can create notes.',
  preference_not_persisted: 'Saving settings shows success but does not persist the preference.',
  ambiguous_checkout_labels: 'Checkout and save-for-later buttons both read "Continue".',
  cart_console_error: 'The cart page throws an uncaught script error.',
  checkout_button_disabled: 'The place-order button is rendered disabled.',
} as const;

export type DefectId = keyof typeof DEFECTS;

export function isDefectId(v: string): v is DefectId {
  return Object.hasOwn(DEFECTS, v);
}

export function parseDefectList(raw: string | undefined): Set<DefectId> {
  const out = new Set<DefectId>();
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isDefectId(part)) throw new Error(`unknown defect: ${part}`);
    out.add(part);
  }
  return out;
}
