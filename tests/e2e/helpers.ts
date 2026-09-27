import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixtureCatalog, loadPolicy, loadValidatedScenario, type Scenario } from '@qa/contracts';
import { FixtureClient } from '@qa/oracles';
import { startFixtureApp, type DefectId, type FixtureApp } from '@qa/fixture-test-app';

export const ROOT = join(import.meta.dirname, '../..');
export const TOKEN = 'e2e-fixture-token-0123456789';

export const policy = await loadPolicy(join(ROOT, 'specs/policies/fixture-shop.yaml'));
export const catalog = await loadFixtureCatalog(join(ROOT, 'specs/fixtures.yaml'));

export async function scenario(id: string, dir = 'scenarios'): Promise<Scenario> {
  return loadValidatedScenario(join(ROOT, 'specs', dir, `${id}.yaml`), catalog, policy);
}

export async function app(defects: DefectId[] = [], extra: { commitSha?: string; checkoutDelayMs?: number } = {}): Promise<{ app: FixtureApp; fixtures: FixtureClient }> {
  const a = await startFixtureApp({ fixtureToken: TOKEN, defects, ...extra });
  return { app: a, fixtures: new FixtureClient(a.url, TOKEN) };
}

export const outDir = () => mkdtemp(join(tmpdir(), 'qa-e2e-'));
