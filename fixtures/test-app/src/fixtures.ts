import { randomUUID } from 'node:crypto';
import type { Role, Store } from './store.ts';

export interface ProvisionResult {
  fixture_id: string;
  name: string;
  data: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
  auth?: { cookies: Array<{ name: string; value: string }> };
}

type Definition = (store: Store, fixtureId: string) => ProvisionResult;

function base(store: Store, fixtureId: string, name: string, role: Role, signedIn: boolean): ProvisionResult & { userId: string } {
  const user = store.createUser(role, fixtureId);
  return {
    userId: user.id,
    fixture_id: fixtureId,
    name,
    data: { customer_id: user.id, email: user.email },
    secrets: { password: user.password },
    ...(signedIn ? { auth: { cookies: [{ name: 'sid', value: store.createSession(user.id) }] } } : {}),
  };
}

/**
 * Fixture definitions. Expected values are written down here from the
 * business rules (2 × Widget at $12.99 + $5.00 shipping = $30.98), *not*
 * computed by the application's own pricing code — otherwise a pricing bug
 * would silently move the expectation with it.
 */
export const FIXTURE_DEFINITIONS: Record<string, Definition> = {
  customer_cart_one_item_v1(store, id) {
    const r = base(store, id, 'customer_cart_one_item_v1', 'customer', true);
    store.carts.set(r.userId, [{ product_id: 'widget', quantity: 2 }]);
    r.data.delivery_address = '1 Test Street, Springfield';
    r.data.expected_total_minor_units = 3098;
    r.data.expected_total_display = '$30.98';
    return r;
  },
  customer_empty_v1(store, id) {
    return base(store, id, 'customer_empty_v1', 'customer', true);
  },
  customer_signed_out_v1(store, id) {
    return base(store, id, 'customer_signed_out_v1', 'customer', false);
  },
  viewer_v1(store, id) {
    return base(store, id, 'viewer_v1', 'viewer', true);
  },
};

export function provision(store: Store, name: string): ProvisionResult | undefined {
  const def = FIXTURE_DEFINITIONS[name];
  if (!def) return undefined;
  const { userId: _drop, ...result } = def(store, `fx_${randomUUID()}`) as ProvisionResult & { userId?: string };
  return result;
}
