import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario } from '@qa/contracts';
import { GitDiffProvider, globToRegex, loadCoverageGraph, normalizeRoute, proposalsFromEquivalenceClasses, selectImpacted, validateProposal, type Comparison } from '../src/index.ts';

const SPECS = join(import.meta.dirname, '../../../specs');
const graph = await loadCoverageGraph(join(SPECS, 'coverage.yaml'));
const policy = await loadPolicy(join(SPECS, 'policies/fixture-shop.yaml'));
const catalog = await loadFixtureCatalog(join(SPECS, 'fixtures.yaml'));
const ids = ['checkout_existing_customer', 'checkout_rejects_empty_address', 'notes_crud', 'settings_preference_persists', 'sign_in', 'viewer_cannot_create_notes', 'cart_quality', 'keyboard_checkout'];
const scenarios = await Promise.all(ids.map((id) => loadValidatedScenario(join(SPECS, 'scenarios', `${id}.yaml`), catalog, policy)));
const exploration = await loadValidatedScenario(join(SPECS, 'exploration/checkout_exploration.yaml'), catalog, policy);

const ok = (...files: Array<string | [string, string]>): Comparison => ({
  kind: 'ok',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  files: files.map((f) => (Array.isArray(f) ? { path: f[1], previous_path: f[0], status: 'renamed' as const } : { path: f, status: 'modified' as const })),
});
const select = (comparison: Comparison, usage = {}) =>
  selectImpacted({ graph, scenarios: [...scenarios, exploration], environment: 'staging', profiles: ['chromium_desktop'], suite_revision: 'r', candidate_sha: 'b'.repeat(40), comparison, usage });
const selected = (m: ReturnType<typeof select>) => [...new Set(m.cases.map((c) => c.scenario_id))].sort();
const smoke = scenarios.filter((s) => s.critical).map((s) => s.id);

describe('globs and routes', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(globToRegex('src/notes/**').test('src/notes/a/b.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegex('**/*.md').test('README.md')).toBe(true);
    expect(globToRegex('**/*.md').test('docs/x/y.md')).toBe(true);
  });
  it('normalizes concrete paths to declared patterns', () => {
    expect(normalizeRoute('/orders/ord_123', ['/orders/:id'])).toBe('/orders/:id');
    expect(normalizeRoute('/orders', ['/orders/:id'])).toBe('/orders');
  });
});

describe('impact selection', () => {
  it('a notes-only change selects notes coverage plus mandatory smoke and explains every omission', () => {
    const m = select(ok('src/notes/list.ts'));
    expect(m.strategy).toBe('impact');
    expect(selected(m)).toEqual([...new Set([...smoke, 'notes_crud', 'viewer_cannot_create_notes'])].sort());
    expect(m.omitted.find((o) => o.scenario_id === 'settings_preference_persists')!.reason).toMatch(/no impacted requirement/);
    const notes = m.cases.find((c) => c.scenario_id === 'notes_crud')!;
    expect(notes.reasons.join()).toMatch(/NOTES-01 via src\/notes\/list.ts → notes/);
    expect(m.exploration).toEqual([]);
  });

  it('a checkout change pulls in impacted checkout scenarios and bounded exploration', () => {
    const m = select(ok('src/pricing/tax.ts'));
    expect(selected(m)).toEqual(expect.arrayContaining(['checkout_existing_customer', 'checkout_rejects_empty_address', 'cart_quality', 'keyboard_checkout']));
    expect(selected(m)).not.toContain('settings_preference_persists');
    expect(m.exploration.map((e) => e.scenario_id)).toEqual(['checkout_exploration']);
  });

  it('observed route usage adds scenarios that visit an impacted route', () => {
    const m = select(ok('src/settings/form.ts'), { notes_crud: ['/notes', '/settings'] });
    expect(selected(m)).toContain('notes_crud');
    expect(m.cases.find((c) => c.scenario_id === 'notes_crud')!.reasons.join()).toMatch(/observed usage/);
  });

  it.each([
    [ok('src/auth/session.ts'), 'risk_triggered'],
    [ok('src/styles/tokens.css'), 'risk_triggered'],
    [ok('package-lock.json'), 'risk_triggered'],
    [ok('migrations/004_add_column.sql'), 'risk_triggered'],
    [ok('src/brand-new-module/x.ts'), 'unknown_impact'],
    [ok(['src/notes/list.ts', 'src/lists/list.ts']), 'unknown_impact'],
    [{ kind: 'non_ancestor', base: 'a'.repeat(40), head: 'b'.repeat(40), detail: 'force push' } as Comparison, 'full_suite'],
    [{ kind: 'unavailable', base: null, head: 'b'.repeat(40), detail: 'no baseline' } as Comparison, 'full_suite'],
  ])('uncertainty broadens to the full suite (%#)', (comparison, reason) => {
    const m = select(comparison);
    expect(m.strategy).toBe('full');
    expect(selected(m)).toEqual([...ids].sort());
    expect(m.cases.every((c) => c.reasons.includes(reason))).toBe(true);
  });

  it('records gaps for unmapped and renamed paths and for missing comparisons', () => {
    expect(select(ok('src/brand-new-module/x.ts')).gaps).toContainEqual(expect.objectContaining({ kind: 'unmapped_path', subject: 'src/brand-new-module/x.ts' }));
    expect(select(ok(['src/notes/list.ts', 'src/lists/list.ts'])).gaps).toContainEqual(expect.objectContaining({ kind: 'renamed_path' }));
    expect(select({ kind: 'unavailable', base: null, head: 'b'.repeat(40), detail: 'no baseline' }).gaps[0]!.kind).toBe('missing_comparison');
  });

  it('declared non-behavioural changes run only the mandatory smoke journeys — never zero coverage', () => {
    const m = select(ok('docs/readme.md'));
    expect(selected(m)).toEqual([...smoke].sort());
    expect(m.cases.length).toBeGreaterThan(0);
    const empty = select(ok());
    expect(selected(empty)).toEqual([...smoke].sort());
  });

  it('reports requirements that no scenario covers', () => {
    const g = { ...graph, capabilities: { ...graph.capabilities, billing: ['BILLING-01'] } };
    const m = selectImpacted({ graph: g, scenarios, environment: 'staging', suite_revision: 'r', candidate_sha: 'b'.repeat(40), comparison: ok('docs/x.md') });
    expect(m.gaps).toContainEqual(expect.objectContaining({ kind: 'requirement_without_scenario', subject: 'BILLING-01' }));
  });
});

describe('git diff provider', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  it('reports renames, and non-ancestor histories as such', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-git-'));
    git(dir, 'init', '-q', '-b', 'main');
    await mkdir(join(dir, 'src/notes'), { recursive: true });
    await writeFile(join(dir, 'src/notes/list.ts'), 'export const a = 1;\n'.repeat(20));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    await mkdir(join(dir, 'src/lists'), { recursive: true });
    await rename(join(dir, 'src/notes/list.ts'), join(dir, 'src/lists/list.ts'));
    await writeFile(join(dir, 'README.md'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'rename');
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = await new GitDiffProvider(dir).compare(base, head);
    expect(r).toMatchObject({ kind: 'ok' });
    expect(r.kind === 'ok' && r.files).toEqual(expect.arrayContaining([{ path: 'src/lists/list.ts', previous_path: 'src/notes/list.ts', status: 'renamed' }, { path: 'README.md', status: 'added' }]));
    git(dir, 'checkout', '-q', '--orphan', 'other');
    git(dir, 'commit', '-qm', 'unrelated');
    const orphan = git(dir, 'rev-parse', 'HEAD');
    expect((await new GitDiffProvider(dir).compare(base, orphan)).kind).toBe('non_ancestor');
    expect((await new GitDiffProvider(dir).compare('f'.repeat(40), head)).kind).toBe('unavailable');
    expect((await new GitDiffProvider(dir).compare(null, head)).kind).toBe('unavailable');
  });
});

describe('test proposals', () => {
  it('equivalence-class proposals validate with declared oracles', () => {
    const props = proposalsFromEquivalenceClasses(graph);
    expect(props.map((p) => (p.scenario as { id: string }).id)).toEqual(['delivery_address_empty', 'delivery_address_whitespace_only', 'delivery_address_too_long', 'delivery_address_max_length']);
    for (const p of props) expect(validateProposal(p, { graph, catalog, policy })).toMatchObject({ ok: true });
  });

  it('rejects proposals that bless current behaviour or lack an oracle', () => {
    const [p] = proposalsFromEquivalenceClasses(graph);
    const observed = { ...p!, oracles: { ...p!.oracles, 'rejected#0': { kind: 'observed', ref: 'page text' } } };
    expect(validateProposal(observed, { graph, catalog, policy })).toMatchObject({ ok: false, errors: [expect.stringMatching(/bless current behaviour/)] });
    const missing = { ...p!, oracles: {} };
    expect((validateProposal(missing, { graph, catalog, policy }) as { errors: string[] }).errors.join()).toMatch(/missing oracle provenance/);
    const unknownReq = { ...p!, scenario: { ...(p!.scenario as object), requirement_ids: ['NOPE-01'] } };
    expect((validateProposal(unknownReq, { graph, catalog, policy }) as { errors: string[] }).errors.join()).toMatch(/not in the requirement graph/);
    const fakeFixture = { ...p!, oracles: { ...p!.oracles, 'rejected#0': { kind: 'fixture', ref: 'fixture.x' } } };
    expect((validateProposal(fakeFixture, { graph, catalog, policy }) as { errors: string[] }).errors.join()).toMatch(/no fixture reference/);
    expect(validateProposal({ source: 's2', rationale: '', scenario: {}, oracles: {}, run: 'rm -rf /' }, { graph, catalog, policy }).ok).toBe(false);
  });
});
