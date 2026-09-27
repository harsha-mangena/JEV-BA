import type { Assertion, Locator, Scenario, Step } from '@qa/contracts';

const q = (s: string) => JSON.stringify(s);

function loc(l: Locator): string {
  if ('testid' in l) return `page.getByTestId(${q(l.testid)})`;
  if ('role' in l) return `page.getByRole(${q(l.role)} as never, { name: ${q(l.name)}, exact: ${l.exact ?? true} })`;
  return `page.getByLabel(${q(l.label)}, { exact: true })`;
}

function value(ref: string): string {
  const [scope, field] = ref.split('.');
  return scope === 'secret' ? `fx.secrets[${q(field!)}]!` : `String(fx.data[${q(field!)}])`;
}

function step(s: Step): string {
  switch (s.op) {
    case 'navigate':
      return `await page.goto(${q(s.path)});`;
    case 'reload':
      return 'await page.reload();';
    case 'press':
      return `for (let i = 0; i < ${s.times}; i++) await page.keyboard.press(${q(s.key === 'Space' ? ' ' : s.key)});`;
    case 'click':
      return `await ${loc(s.target)}.click();\n    await page.waitForLoadState('networkidle');`;
    case 'type':
      return `await ${loc(s.target)}.fill(${s.value_ref ? value(s.value_ref) : q(s.value!)});`;
    case 'select':
      return `await ${loc(s.target)}.selectOption({ label: ${s.option_ref ? value(s.option_ref) : q(s.option!)} });`;
  }
}

const SUPPORTED = new Set(['ui_visible', 'ui_hidden', 'ui_text', 'url_path', 'order_count_delta', 'order_total_minor_units', 'entity_count_delta', 'persists_after_reload', 'no_console_errors']);

function assertion(a: Assertion): string {
  switch (a.type) {
    case 'ui_visible':
      return `await expect(${loc(a.target)}).toBeVisible();`;
    case 'ui_hidden':
      return `await expect(${loc(a.target)}).toBeHidden();`;
    case 'ui_text':
      return a.contains !== undefined ? `await expect(${loc(a.target)}).toContainText(${q(a.contains)});` : `await expect(${loc(a.target)}).toHaveText(${a.equals_ref ? value(a.equals_ref) : q(a.equals!)});`;
    case 'url_path':
      return `await expect.poll(() => new URL(page.url()).pathname).toBe(${q(a.equals)});`;
    case 'order_count_delta':
      return `await expect.poll(async () => (await owned('orders', ${value(a.customer_ref)})).length - before.orders.length).toBe(${a.equals});`;
    case 'entity_count_delta':
      return `await expect.poll(async () => (await owned(${q(a.entity === 'order' ? 'orders' : 'notes')}, ${value(a.owner_ref)})).length - before.${a.entity === 'order' ? 'orders' : 'notes'}.length).toBe(${a.equals});`;
    case 'order_total_minor_units': {
      const expected = a.equals_ref ? `Number(${value(a.equals_ref)})` : String(a.equals);
      return `await expect.poll(async () => (await owned('orders', String(fx.data.customer_id))).filter((o) => !before.orders.some((b) => b.id === o.id)).map((o) => o.total_minor_units)).toEqual([${expected}]);`;
    }
    case 'persists_after_reload':
      return `await page.reload();\n    await expect(${loc(a.target)}).toBeVisible();`;
    case 'no_console_errors':
      return 'expect(consoleErrors).toEqual([]);';
    default:
      throw new Error(`unsupported assertion ${a.type}`);
  }
}

/**
 * Emit a standalone Playwright Test file for a regression scenario. The YAML
 * contract stays the source of truth; the spec is a convenience export that
 * must reproduce the contract's verdicts (checked by validation). Assertion
 * types the emitter cannot express faithfully are refused, never skipped.
 */
export function emitPlaywrightSpec(s: Scenario): string {
  const unsupported = s.milestones.flatMap((m) => m.assertions.filter((a) => !SUPPORTED.has(a.type)).map((a) => a.type));
  if (unsupported.length) throw new Error(`cannot emit a faithful spec: unsupported assertion type(s) ${[...new Set(unsupported)].join(', ')}`);
  const body = s.milestones
    .map(
      (m) => `  await test.step(${q(m.id)}, async () => {
${m.steps.map((st) => `    ${step(st)}`).join('\n')}
${m.assertions.map((a) => `    ${assertion(a)}`).join('\n')}
  });`,
    )
    .join('\n');
  return `// Generated from scenario ${s.id} (requirements: ${s.requirement_ids.join(', ')}). Do not edit; regenerate from the contract.
import { expect, test } from '@playwright/test';

const BASE = process.env.QA_BASE_URL!;
const TOKEN = process.env.QA_FIXTURE_TOKEN!;
type Fixture = { fixture_id: string; data: Record<string, string | number>; secrets: Record<string, string>; auth?: { cookies: Array<{ name: string; value: string }> } };
type Owned = { id: string; total_minor_units: number };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, BASE), { method, headers: { 'x-qa-fixture-token': TOKEN, 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) });
  if (!res.ok) throw new Error(\`\${method} \${path}: HTTP \${res.status}\`);
  return (await res.json()) as T;
}
const owned = async (kind: 'orders' | 'notes', user: string) => (await api<Record<string, Owned[]>>('GET', \`/__qa/users/\${user}/\${kind}\`))[kind]!;

test.use({ baseURL: BASE });

test(${q(`${s.id}: ${s.goal}`)}, async ({ page, context }) => {
  const fx = await api<Fixture>('POST', '/__qa/fixtures', { name: ${q(s.fixture)} });
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  try {
    if (fx.auth) await context.addCookies(fx.auth.cookies.map((c) => ({ ...c, url: BASE })));
    const user = String(fx.data.customer_id);
    const before = { orders: await owned('orders', user), notes: await owned('notes', user) };
    await page.goto(${q(s.start_path)});
${body}
  } finally {
    await api('DELETE', \`/__qa/fixtures/\${fx.fixture_id}\`);
  }
});
`;
}

/** Static policy for generated or repaired test code. */
export function lintGeneratedSpec(source: string): string[] {
  const rules: Array<[RegExp, string]> = [
    [/\btest\.(skip|fixme|only)\b|\.skip\(|\.only\(/, 'skips, fixme or focused tests are not allowed'],
    [/force:\s*true/, 'forced actions are not allowed'],
    [/page\.(evaluate|addScriptTag|route)\b/, 'arbitrary in-page scripts or network interception are not allowed'],
    [/child_process|node:fs|process\.exit|eval\(|new Function/, 'filesystem, process or dynamic code access is not allowed'],
    [/expect\.soft/, 'soft assertions would weaken the contract'],
  ];
  return rules.filter(([re]) => re.test(source)).map(([, why]) => why);
}
