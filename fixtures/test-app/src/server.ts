import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFECTS, type DefectId, isDefectId } from './defects.ts';
import { provision } from './fixtures.ts';
import { PRODUCTS, Store, type User } from './store.ts';
import * as v from './views.ts';

export interface FixtureAppOptions {
  port?: number;
  host?: string;
  defects?: Iterable<DefectId>;
  /** Required for the /__qa fixture API. */
  fixtureToken: string;
  commitSha?: string;
  /** Artificial latency on checkout, to exercise waiting/actionability logic. */
  checkoutDelayMs?: number;
}

export interface FixtureApp {
  url: string;
  store: Store;
  defects: Set<DefectId>;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw Object.assign(new Error('expected JSON object'), { status: 400 });
  return parsed as Record<string, unknown>;
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return out;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');
const redirect = (res: ServerResponse, to: string, headers: Record<string, string> = {}) => send(res, 303, '', 'text/plain', { location: to, ...headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startFixtureApp(opts: FixtureAppOptions): Promise<FixtureApp> {
  if (!opts.fixtureToken || opts.fixtureToken.length < 16) throw new Error('fixtureToken must be at least 16 characters');
  const store = new Store();
  const defects = new Set<DefectId>(opts.defects ?? []);
  const revision = opts.commitSha ?? '0'.repeat(40);
  const cartVersions = new Map<string, string>();
  const has = (d: DefectId) => defects.has(d);

  const cartVersion = (userId: string) => {
    let ver = cartVersions.get(userId);
    if (!ver) cartVersions.set(userId, (ver = randomBytes(8).toString('hex')));
    return ver;
  };
  const bumpCart = (userId: string) => cartVersions.delete(userId);

  const defectCss = () =>
    [
      has('mobile_horizontal_overflow') ? 'table{min-width:900px}' : '',
      has('focus_outline_removed') ? '*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}' : '',
      has('header_restyled') ? 'header{background:#6b2fb3!important}' : '',
    ].join('');
  const page = (res: ServerResponse, status: number, title: string, user: User | null, body: string, script?: string, extraBody?: string) =>
    send(res, status, v.layout({ title, user, revision, body, extraCss: defectCss(), ...(script ? { script } : {}), ...(extraBody ? { extraBody } : {}) }));

  function renderCart(res: ServerResponse, user: User, status: number, extra: { error?: string; saved?: boolean; address?: string } = {}) {
    const lines = (store.carts.get(user.id) ?? []).map((l) => {
      const p = PRODUCTS.find((x) => x.id === l.product_id)!;
      return { name: p.name, quantity: l.quantity, line_minor_units: p.price_minor_units * l.quantity };
    });
    const body = v.cartPage({
      lines,
      totals: store.cartTotal(user.id),
      ...extra,
      ambiguousLabels: has('ambiguous_checkout_labels'),
      checkoutDisabled: has('checkout_button_disabled'),
      cartVersion: cartVersion(user.id),
      unlabeledAddress: has('address_label_missing'),
      renamedCheckout: has('checkout_button_renamed'),
    });
    const promo = has('promo_overlay') ? '<div data-testid="promo" style="position:fixed;left:0;right:0;top:120px;bottom:0;background:#fff3c4;z-index:10;padding:16px">Spring sale — 10% off everything!</div>' : undefined;
    page(res, status, 'Your cart', user, body, has('cart_console_error') ? "throw new Error('cart widget failed to initialise')" : undefined, promo);
  }

  async function handleQa(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const header = req.headers['x-qa-fixture-token'];
    if (!tokenMatches(Array.isArray(header) ? header[0] : header, opts.fixtureToken)) return sendJson(res, 401, { error: 'fixture token required' });
    const m = req.method ?? 'GET';
    if (m === 'GET' && path === '/__qa/effects') {
      const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? '';
      const effects = [...store.orders.values()].filter((o) => key && o.idempotency_key === key).map((o) => ({ kind: 'order', entity_id: o.id, owner: o.customer_id, idempotency_key: o.idempotency_key, created_at: o.created_at }));
      return sendJson(res, 200, { effects });
    }
    if (m === 'GET' && path === '/__qa/version') return sendJson(res, 200, { commit_sha: revision, defects: [...defects].sort() });
    if (m === 'PUT' && path === '/__qa/defects') {
      const body = await json(req);
      const list = body.defects;
      if (!Array.isArray(list) || !list.every((d): d is DefectId => typeof d === 'string' && isDefectId(d))) {
        return sendJson(res, 400, { error: 'defects must be a list of known defect ids', known: Object.keys(DEFECTS) });
      }
      defects.clear();
      for (const d of list) defects.add(d);
      return sendJson(res, 200, { defects: [...defects].sort() });
    }
    if (m === 'POST' && path === '/__qa/fixtures') {
      const body = await json(req);
      const result = typeof body.name === 'string' ? provision(store, body.name) : undefined;
      return result ? sendJson(res, 201, result) : sendJson(res, 404, { error: `unknown fixture ${String(body.name)}` });
    }
    let mm = path.match(/^\/__qa\/fixtures\/([\w-]+)$/);
    if (m === 'DELETE' && mm) return sendJson(res, 200, { removed: store.deleteFixture(mm[1]!) });
    mm = path.match(/^\/__qa\/users\/([\w-]+)\/(orders|notes)$/);
    if (m === 'GET' && mm) {
      const user = store.users.get(mm[1]!);
      if (!user) return sendJson(res, 404, { error: 'unknown user' });
      return sendJson(res, 200, mm[2] === 'orders' ? { orders: store.ordersFor(user.id) } : { notes: store.notesFor(user.id) });
    }
    mm = path.match(/^\/__qa\/users\/([\w-]+)$/);
    if (m === 'GET' && mm) {
      const user = store.users.get(mm[1]!);
      return user ? sendJson(res, 200, { id: user.id, role: user.role, preferences: user.preferences, profile: user.profile }) : sendJson(res, 404, { error: 'unknown user' });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path.startsWith('/__qa/')) return handleQa(req, res, path);
    if (method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true, commit_sha: revision });

    const sid = cookies(req).get('sid');
    const userId = sid ? store.sessions.get(sid) : undefined;
    const user = userId ? (store.users.get(userId) ?? null) : null;
    if (method !== 'GET' && method !== 'HEAD') store.writes.push({ method, path, user_id: user?.id ?? null, at: new Date().toISOString() });

    if (path === '/login') {
      if (method === 'GET') return page(res, 200, 'Sign in', null, v.loginPage());
      const f = await form(req);
      const u = store.findUserByEmail(f.get('email') ?? '');
      if (!u || !tokenMatches(f.get('password') ?? '', u.password)) return page(res, 401, 'Sign in', null, v.loginPage('Invalid email or password.'));
      return redirect(res, '/products', { 'set-cookie': `sid=${store.createSession(u.id)}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (!user) return redirect(res, '/login');

    if (method === 'POST' && path === '/logout') {
      if (sid) store.sessions.delete(sid);
      return redirect(res, '/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (method === 'GET' && path === '/') return redirect(res, '/products');
    if (method === 'GET' && path === '/products') return page(res, 200, 'Products', user, v.productsPage());
    if (method === 'POST' && path === '/cart/add') {
      const productId = (await form(req)).get('product_id') ?? '';
      if (!PRODUCTS.some((p) => p.id === productId)) return page(res, 400, 'Products', user, `<p role="alert">Unknown product.</p>${v.productsPage()}`);
      const lines = store.carts.get(user.id) ?? [];
      const line = lines.find((l) => l.product_id === productId);
      if (line) line.quantity += 1;
      else lines.push({ product_id: productId, quantity: 1 });
      store.carts.set(user.id, lines);
      bumpCart(user.id);
      return redirect(res, '/cart');
    }
    if (method === 'GET' && path === '/cart') return renderCart(res, user, 200);
    if (method === 'POST' && path === '/cart/save') {
      const f = await form(req);
      return renderCart(res, user, 200, { saved: true, address: f.get('delivery_address') ?? '' });
    }
    if (method === 'POST' && path === '/checkout') {
      const f = await form(req);
      if (opts.checkoutDelayMs) await sleep(opts.checkoutDelayMs);
      const lines = store.carts.get(user.id) ?? [];
      if (lines.length === 0) return renderCart(res, user, 409, { error: 'Your cart is empty.' });
      if (f.get('cart_version') !== cartVersion(user.id)) {
        return renderCart(res, user, 409, { error: 'Your cart changed. Please review it and submit again.' });
      }
      const address = (f.get('delivery_address') ?? '').trim();
      if (!has('validation_bypass')) {
        if (!address) return renderCart(res, user, 422, { error: 'Delivery address is required.', address });
        if (address.length > 200) return renderCart(res, user, 422, { error: 'Delivery address must be 200 characters or fewer.', address });
      }
      // Test integration: an idempotency key (scoped to this endpoint by the QA runner) deduplicates submissions.
      const idemKey = (req.headers['x-qa-idempotency-key'] as string | undefined) ?? null;
      if (idemKey) {
        const prior = [...store.orders.values()].find((o) => o.customer_id === user.id && o.idempotency_key === idemKey);
        if (prior) return redirect(res, `/orders/${prior.id}`);
      }
      const { shipping, total } = store.cartTotal(user.id);
      const makeOrder = () => {
        const order = {
          id: `ord_${randomUUID().slice(0, 8)}`,
          customer_id: user.id,
          lines: lines.map((l) => ({ ...l, unit_price_minor_units: PRODUCTS.find((p) => p.id === l.product_id)!.price_minor_units })),
          shipping_minor_units: shipping,
          total_minor_units: total + (has('total_off_by_one') ? 1 : 0),
          delivery_address: address,
          created_at: new Date().toISOString(),
          idempotency_key: idemKey,
        };
        store.orders.set(order.id, order);
        return order;
      };
      const order = makeOrder();
      if (has('checkout_double_submit')) makeOrder();
      store.carts.set(user.id, []);
      bumpCart(user.id);
      return redirect(res, has('confirmation_missing') ? '/cart' : `/orders/${order.id}`);
    }
    if (method === 'GET' && path === '/orders') return page(res, 200, 'Your orders', user, v.ordersPage(store.ordersFor(user.id)));
    let mm = path.match(/^\/orders\/([\w-]+)$/);
    if (method === 'GET' && mm) {
      const order = store.orders.get(mm[1]!);
      if (!order || order.customer_id !== user.id) return page(res, 404, 'Order not found', user, '<p>We could not find that order.</p>');
      return page(res, 200, 'Order confirmation', user, v.orderPage(order));
    }

    const canWrite = user.role !== 'viewer' || has('role_escalation');
    const notesView = (status: number, extra: { error?: string; flash?: string } = {}) =>
      page(res, status, 'Notes', user, v.notesPage({ notes: store.notesFor(user.id), canWrite, ...extra }), v.DIALOG_SCRIPT);
    if (method === 'GET' && path === '/notes') return notesView(200, url.searchParams.get('flash') ? { flash: url.searchParams.get('flash')! } : {});
    if (method === 'POST' && path === '/notes') {
      if (!canWrite) return notesView(403, { error: 'You do not have permission to create notes.' });
      const f = await form(req);
      const title = (f.get('title') ?? '').trim();
      if (!title) return notesView(422, { error: 'Note title is required.' });
      const id = `note_${randomUUID().slice(0, 8)}`;
      store.notes.set(id, { id, owner_id: user.id, title: title.slice(0, 80), body: (f.get('body') ?? '').slice(0, 2000) });
      return redirect(res, '/notes?flash=Note+added.');
    }
    mm = path.match(/^\/notes\/([\w-]+)(\/edit|\/delete)?$/);
    if (mm) {
      const note = store.notes.get(mm[1]!);
      if (!note || note.owner_id !== user.id) return page(res, 404, 'Note not found', user, '<p>We could not find that note.</p>');
      if (!canWrite) return notesView(403, { error: 'You do not have permission to change notes.' });
      if (method === 'GET' && mm[2] === '/edit') return page(res, 200, 'Edit note', user, v.editNotePage(note));
      if (method === 'POST' && mm[2] === '/delete') {
        if (!has('note_delete_ignored')) store.notes.delete(note.id);
        return redirect(res, '/notes?flash=Note+deleted.');
      }
      if (method === 'POST' && !mm[2]) {
        const f = await form(req);
        const title = (f.get('title') ?? '').trim();
        if (!title) return page(res, 422, 'Edit note', user, `<p role="alert" class="error">Note title is required.</p>${v.editNotePage(note)}`);
        note.title = title.slice(0, 80);
        note.body = (f.get('body') ?? '').slice(0, 2000);
        return redirect(res, '/notes?flash=Note+updated.');
      }
    }
    if (method === 'GET' && path === '/settings') return page(res, 200, 'Settings', user, v.settingsPage(user.preferences.theme, url.searchParams.has('saved'), user.profile), v.AUTOSAVE_SCRIPT);
    if (method === 'POST' && (path === '/settings/profile' || path === '/settings/profile/autosave')) {
      const nickname = ((await form(req)).get('nickname') ?? '').slice(0, 60);
      user.profile.nickname = nickname;
      return path.endsWith('autosave') ? sendJson(res, 200, { saved: true }) : redirect(res, '/settings?saved=1');
    }
    if (method === 'POST' && path === '/settings/email') {
      user.profile.email_offers = (await form(req)).get('offers') === 'on';
      return redirect(res, '/settings?saved=1');
    }
    if (method === 'POST' && path === '/settings') {
      const theme = (await form(req)).get('theme');
      if (theme !== 'light' && theme !== 'dark') return page(res, 422, 'Settings', user, `<p role="alert" class="error">Unknown theme.</p>${v.settingsPage(user.preferences.theme, false)}`);
      if (!has('preference_not_persisted')) user.preferences.theme = theme;
      return redirect(res, '/settings?saved=1');
    }
    if (method === 'GET' && path === '/admin') {
      if (user.role !== 'admin') return page(res, 403, 'Access denied', user, '<p role="alert" data-testid="access-denied">You do not have access to this page.</p>');
      return page(res, 200, 'Admin', user, `<p>${store.orders.size} orders.</p>`);
    }
    return page(res, 404, 'Not found', user, '<p>Page not found.</p>');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = (err as { status?: number }).status ?? 500;
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    store,
    defects,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
