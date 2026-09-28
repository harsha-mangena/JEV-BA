import { randomBytes, randomUUID } from 'node:crypto';

export type Role = 'customer' | 'viewer' | 'admin';

export interface User {
  id: string;
  email: string;
  password: string;
  role: Role;
  fixture_id: string | null;
  preferences: { theme: 'light' | 'dark' };
  profile: { nickname: string; email_offers: boolean };
}

export interface Product {
  id: string;
  name: string;
  price_minor_units: number;
}

export interface CartLine {
  product_id: string;
  quantity: number;
}

export interface Order {
  id: string;
  customer_id: string;
  lines: Array<CartLine & { unit_price_minor_units: number }>;
  shipping_minor_units: number;
  total_minor_units: number;
  delivery_address: string;
  created_at: string;
  idempotency_key: string | null;
}

export interface Note {
  id: string;
  owner_id: string;
  title: string;
  body: string;
}

export const SHIPPING_MINOR_UNITS = 500;

export const PRODUCTS: readonly Product[] = [
  { id: 'widget', name: 'Widget', price_minor_units: 1299 },
  { id: 'gadget', name: 'Gadget', price_minor_units: 2450 },
];

/** In-memory application state. Everything is scoped to a user so parallel fixtures never collide. */
export class Store {
  readonly users = new Map<string, User>();
  readonly sessions = new Map<string, string>();
  readonly carts = new Map<string, CartLine[]>();
  readonly orders = new Map<string, Order>();
  readonly notes = new Map<string, Note>();
  /** Every state-changing application request that reached a handler (test oracle: backend effect count). */
  readonly writes: Array<{ method: string; path: string; user_id: string | null; idempotency_key: string | null; at: string }> = [];

  createUser(role: Role, fixture_id: string | null): User {
    const id = `u_${randomUUID().slice(0, 8)}`;
    const user: User = {
      id,
      email: `${id}@fixture.test`,
      password: randomBytes(12).toString('base64url'),
      role,
      fixture_id,
      preferences: { theme: 'light' },
      profile: { nickname: '', email_offers: false },
    };
    this.users.set(id, user);
    this.carts.set(id, []);
    return user;
  }

  findUserByEmail(email: string): User | undefined {
    for (const u of this.users.values()) if (u.email === email) return u;
    return undefined;
  }

  createSession(userId: string): string {
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, userId);
    return token;
  }

  cartTotal(userId: string): { subtotal: number; shipping: number; total: number } {
    const lines = this.carts.get(userId) ?? [];
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * (PRODUCTS.find((p) => p.id === l.product_id)?.price_minor_units ?? 0), 0);
    const shipping = lines.length > 0 ? SHIPPING_MINOR_UNITS : 0;
    return { subtotal, shipping, total: subtotal + shipping };
  }

  ordersFor(userId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.customer_id === userId);
  }

  notesFor(userId: string): Note[] {
    return [...this.notes.values()].filter((n) => n.owner_id === userId);
  }

  /** Remove every entity owned by users created for this fixture. */
  deleteFixture(fixtureId: string): number {
    let removed = 0;
    for (const u of [...this.users.values()]) {
      if (u.fixture_id !== fixtureId) continue;
      for (const o of this.ordersFor(u.id)) this.orders.delete(o.id) && removed++;
      for (const n of this.notesFor(u.id)) this.notes.delete(n.id) && removed++;
      for (const [token, uid] of this.sessions) if (uid === u.id) this.sessions.delete(token);
      this.carts.delete(u.id);
      this.users.delete(u.id);
      removed++;
    }
    return removed;
  }
}
