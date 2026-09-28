import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario } from '@qa/contracts';
import { loadCoverageGraph, loadSelectionBenchmark, measureSelectionRecall } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '../../..');
const SPECS = join(ROOT, 'specs');
const graph = await loadCoverageGraph(join(SPECS, 'coverage.yaml'));
const policy = await loadPolicy(join(SPECS, 'policies/fixture-shop.yaml'));
const catalog = await loadFixtureCatalog(join(SPECS, 'fixtures.yaml'));
const ids = ['checkout_existing_customer', 'checkout_rejects_empty_address', 'notes_crud', 'settings_preference_persists', 'sign_in', 'viewer_cannot_create_notes', 'cart_quality', 'keyboard_checkout'];
const scenarios = await Promise.all(ids.map((id) => loadValidatedScenario(join(SPECS, 'scenarios', `${id}.yaml`), catalog, policy)));
const benchmark = await loadSelectionBenchmark(join(SPECS, 'selection-benchmark.yaml'));

describe('selection recall (completion phase 9)', () => {
  it('selects a detecting scenario for every benchmark defect, and records the measurement', async () => {
    const r = measureSelectionRecall(benchmark, graph, scenarios);
    await mkdir(join(ROOT, '.qa-work', 'evidence'), { recursive: true });
    await writeFile(join(ROOT, '.qa-work', 'evidence', 'selection-recall.json'), `${JSON.stringify(r, null, 2)}\n`);
    expect(r.missed).toEqual([]);
    expect(r.recall).toBe(1);
    // Selection must still save work on at least some changes, or it is not selective at all.
    expect(r.mean_selected_fraction).toBeLessThan(1);
  });

  it('detects a wrong mapping as a recall loss (the measurement can fail)', () => {
    // Unmapped paths broaden to the full suite (safe); a path mapped to the *wrong* component does not.
    const broken = structuredClone(graph);
    broken.components = broken.components.map((c) => (c.id === 'notes' ? { ...c, paths: ['src/notes-legacy/**'] } : c.id === 'settings' ? { ...c, paths: [...c.paths, 'src/notes/**'] } : c));
    const r = measureSelectionRecall(benchmark, broken, scenarios);
    expect(r.recall).toBeLessThan(1);
    expect(r.missed.map((m) => m.defect)).toEqual(expect.arrayContaining(['note_delete_ignored']));
  });

  it('rejects a benchmark naming scenarios that do not exist', () => {
    expect(() => measureSelectionRecall({ schema_version: 1, cases: [{ defect: 'x', changed: ['src/a.ts'], detected_by: ['nope'] }] }, graph, scenarios)).toThrow(/unknown scenario nope/);
  });
});
