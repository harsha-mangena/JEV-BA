import type { Note, Order, User } from './store.ts';
import { PRODUCTS } from './store.ts';

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const STYLE = `
*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1b1b1f;background:#fafafa}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;background:#20232a;color:#fff}
header a{color:#fff}header form{margin-left:auto}main{max-width:760px;margin:0 auto;padding:16px}
nav ul{display:flex;gap:12px;list-style:none;margin:0;padding:0;flex-wrap:wrap}
label{display:block;font-weight:600;margin-top:12px}input,select,textarea{width:100%;padding:8px;font:inherit}
button{padding:8px 14px;font:inherit;cursor:pointer;margin-top:12px}.actions{display:flex;gap:12px;flex-wrap:wrap}
.error{color:#a4001d;border-left:4px solid #a4001d;padding:4px 8px}.ok{color:#05603a;border-left:4px solid #05603a;padding:4px 8px}
table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}
dialog{max-width:90vw}`;

export function layout(opts: { title: string; user?: User | null; revision: string; body: string; script?: string; extraCss?: string; extraBody?: string }): string {
  const nav = opts.user
    ? `<nav aria-label="Primary"><ul>
        <li><a href="/products">Products</a></li><li><a href="/cart">Cart</a></li>
        <li><a href="/orders">Orders</a></li><li><a href="/notes">Notes</a></li><li><a href="/settings">Settings</a></li>
      </ul></nav>
      <form method="post" action="/logout"><span data-testid="current-user">${esc(opts.user.email)}</span> <button type="submit">Sign out</button></form>`
    : '';
  return `<!doctype html><html lang="en" data-theme="${opts.user?.preferences.theme ?? 'light'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="build-revision" content="${esc(opts.revision)}">
<title>${esc(opts.title)} · Fixture Shop</title><style>${STYLE}${opts.extraCss ?? ''}</style></head>
<body><header><strong>Fixture Shop</strong>${nav}</header><main id="main"><h1>${esc(opts.title)}</h1>${opts.body}</main>${opts.extraBody ?? ''}
${opts.script ? `<script>${opts.script}</script>` : ''}</body></html>`;
}

export function loginPage(error?: string): string {
  return `${error ? `<p role="alert" class="error" data-testid="login-error">${esc(error)}</p>` : ''}
<form method="post" action="/login" aria-label="Sign in">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`;
}

export function productsPage(): string {
  return `<ul aria-label="Products">${PRODUCTS.map(
    (p) => `<li><span>${esc(p.name)}</span> — <span>${money(p.price_minor_units)}</span>
      <form method="post" action="/cart/add" style="display:inline"><input type="hidden" name="product_id" value="${esc(p.id)}">
      <button type="submit" aria-label="Add ${esc(p.name)} to cart">Add to cart</button></form></li>`,
  ).join('')}</ul>`;
}

export function cartPage(opts: {
  lines: Array<{ name: string; quantity: number; line_minor_units: number }>;
  totals: { subtotal: number; shipping: number; total: number };
  error?: string;
  saved?: boolean;
  address?: string;
  ambiguousLabels: boolean;
  checkoutDisabled: boolean;
  cartVersion: string;
  unlabeledAddress?: boolean;
}): string {
  if (opts.lines.length === 0) {
    return `${opts.error ? `<p role="alert" class="error" data-testid="checkout-error">${esc(opts.error)}</p>` : ''}
<p data-testid="cart-empty">Your cart is empty.</p><a href="/products">Browse products</a>`;
  }
  const rows = opts.lines
    .map((l) => `<tr><td>${esc(l.name)}</td><td>${l.quantity}</td><td>${money(l.line_minor_units)}</td></tr>`)
    .join('');
  const placeLabel = opts.ambiguousLabels ? 'Continue' : 'Place order';
  const saveLabel = opts.ambiguousLabels ? 'Continue' : 'Save cart for later';
  return `${opts.saved ? '<p role="status" class="ok" data-testid="cart-saved">Cart saved for later.</p>' : ''}
<section aria-labelledby="cart-heading"><h2 id="cart-heading">Items</h2>
<table data-testid="cart-lines"><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
<p>Subtotal: <span data-testid="cart-subtotal">${money(opts.totals.subtotal)}</span></p>
<p>Shipping: <span data-testid="cart-shipping">${money(opts.totals.shipping)}</span></p>
<p><strong>Total: <span data-testid="cart-total">${money(opts.totals.total)}</span></strong></p></section>
<section aria-labelledby="checkout-heading"><h2 id="checkout-heading">Checkout</h2>
${opts.error ? `<p role="alert" class="error" id="address-error" data-testid="address-error">${esc(opts.error)}</p>` : ''}
<form method="post" action="/checkout" id="checkout-form" aria-label="Checkout">
  <input type="hidden" name="cart_version" value="${esc(opts.cartVersion)}">
  ${opts.unlabeledAddress ? '' : '<label for="delivery_address">Delivery address</label>'}
  <textarea id="delivery_address" name="delivery_address" rows="2"${opts.error ? ' aria-invalid="true" aria-describedby="address-error"' : ''}>${esc(opts.address ?? '')}</textarea>
  <div class="actions">
    <button type="submit" data-testid="place-order"${opts.checkoutDisabled ? ' disabled' : ''}>${placeLabel}</button>
    <button type="submit" formaction="/cart/save" formnovalidate data-testid="save-cart">${saveLabel}</button>
  </div>
</form></section>`;
}

export function orderPage(o: Order): string {
  return `<section data-testid="order-confirmation" aria-labelledby="confirm-heading">
<h2 id="confirm-heading">Order confirmed</h2>
<p>Order number: <span data-testid="order-id">${esc(o.id)}</span></p>
<p>Total charged: <span data-testid="order-total">${money(o.total_minor_units)}</span></p>
<p>Delivering to: <span data-testid="order-address">${esc(o.delivery_address)}</span></p></section>`;
}

export function ordersPage(orders: Order[]): string {
  if (orders.length === 0) return '<p data-testid="orders-empty">No orders yet.</p>';
  return `<ul data-testid="orders-list">${orders
    .map((o) => `<li><a href="/orders/${esc(o.id)}">${esc(o.id)}</a> — ${money(o.total_minor_units)}</li>`)
    .join('')}</ul>`;
}

export function notesPage(opts: { notes: Note[]; canWrite: boolean; error?: string; flash?: string }): string {
  const items = opts.notes.length
    ? `<ul data-testid="notes-list">${opts.notes
        .map(
          (n) => `<li data-testid="note-item"><strong data-testid="note-title">${esc(n.title)}</strong> <span>${esc(n.body)}</span>
      ${opts.canWrite ? `<a href="/notes/${esc(n.id)}/edit" aria-label="Edit ${esc(n.title)}">Edit</a>
      <button type="button" data-open-dialog="del-${esc(n.id)}" aria-label="Delete ${esc(n.title)}">Delete</button>
      <dialog id="del-${esc(n.id)}" aria-labelledby="del-${esc(n.id)}-h"><h2 id="del-${esc(n.id)}-h">Delete “${esc(n.title)}”?</h2>
        <form method="post" action="/notes/${esc(n.id)}/delete"><div class="actions">
          <button type="button" data-close-dialog>Cancel</button><button type="submit">Confirm delete</button></div></form></dialog>` : ''}</li>`,
        )
        .join('')}</ul>`
    : '<p data-testid="notes-empty">No notes yet.</p>';
  const form = opts.canWrite
    ? `<form method="post" action="/notes" aria-label="New note">
  <label for="note_title">Note title</label><input id="note_title" name="title" maxlength="80">
  <label for="note_body">Note body</label><textarea id="note_body" name="body" rows="3"></textarea>
  <button type="submit">Add note</button></form>`
    : '<p data-testid="read-only-notice">You have read-only access.</p>';
  return `${opts.flash ? `<p role="status" class="ok" data-testid="notes-flash">${esc(opts.flash)}</p>` : ''}
${opts.error ? `<p role="alert" class="error" data-testid="notes-error">${esc(opts.error)}</p>` : ''}${items}${form}`;
}

export const DIALOG_SCRIPT = `document.addEventListener('click',e=>{const o=e.target.closest('[data-open-dialog]');if(o){document.getElementById(o.dataset.openDialog).showModal();}
const c=e.target.closest('[data-close-dialog]');if(c){c.closest('dialog').close();}});`;

export function editNotePage(n: Note): string {
  return `<form method="post" action="/notes/${esc(n.id)}" aria-label="Edit note">
  <label for="note_title">Note title</label><input id="note_title" name="title" value="${esc(n.title)}" maxlength="80">
  <label for="note_body">Note body</label><textarea id="note_body" name="body" rows="3">${esc(n.body)}</textarea>
  <button type="submit">Save note</button></form>`;
}

export function settingsPage(theme: string, saved: boolean): string {
  return `${saved ? '<p role="status" class="ok" data-testid="settings-saved">Settings saved.</p>' : ''}
<form method="post" action="/settings" aria-label="Settings">
  <label for="theme">Theme</label><select id="theme" name="theme">
    <option value="light"${theme === 'light' ? ' selected' : ''}>Light</option>
    <option value="dark"${theme === 'dark' ? ' selected' : ''}>Dark</option></select>
  <p>Current theme: <span data-testid="current-theme">${esc(theme)}</span></p>
  <button type="submit">Save settings</button></form>`;
}
