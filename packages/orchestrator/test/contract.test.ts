import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '@qa/contracts';
import { FrozenBaselineStore, FsBaselineStore } from '@qa/quality';
import { contractChanges, loadSuite, resolveExecution } from '../src/suite.ts';

const ROOT = join(import.meta.dirname, '../../..');
const cfg = (over: Record<string, unknown> = {}) =>
  ProjectConfig.parse({
    schema_version: 1,
    environments: { staging: { url_patterns: ['http://127.0.0.1:*'], allow_private_network: true } },
    version_check: { kind: 'json', path: '/healthz', field: 'commit_sha' },
    suite: { specs_dir: 'specs', policy_file: 'specs/policies/fixture-shop.yaml', fixture_catalog: 'specs/fixtures.yaml', profiles: ['chromium_desktop'] },
    fixture_api: { token_env: 'QA_FIXTURE_TOKEN' },
    ...over,
  });

describe('execution contract (re-audit R2)', () => {
  it('R2a/R2b: a different oracle backend is a different execution identity, and the change is named', async () => {
    const a = cfg({ fixture_api: { token_env: 'QA_FIXTURE_TOKEN', url: 'http://oracle-a.internal:4310' } });
    const b = cfg({ fixture_api: { token_env: 'QA_FIXTURE_TOKEN', url: 'http://oracle-b.internal:4310' } });
    const [sa, sb] = await Promise.all([loadSuite(a, ROOT), loadSuite(b, ROOT)]);
    const [ea, eb] = await Promise.all([resolveExecution(a, 'staging', sa), resolveExecution(b, 'staging', sb)]);
    expect(ea.revision).not.toBe(eb.revision);
    expect(contractChanges(ea.contract, eb.contract)).toEqual(['oracle: endpoint']);
    // Identical inputs are one identity, and the credential reference is hashed, never included in clear.
    expect((await resolveExecution(a, 'staging', sa)).revision).toBe(ea.revision);
    expect(JSON.stringify(ea.contract)).not.toContain('QA_FIXTURE_TOKEN');
  });

  it('binds environment policy, version verification, adapter and rendering identities', async () => {
    const s = await loadSuite(cfg(), ROOT);
    const e = await resolveExecution(cfg(), 'staging', s);
    expect(e.contract.environment).toEqual({ name: 'staging', policy: cfg().environments.staging });
    expect(e.contract.verification.version_check).toEqual(cfg().version_check);
    expect(e.contract.oracle).toMatchObject({ adapter: 'fixture-shop', adapter_version: 'fixture-shop-adapter/3', endpoint: 'candidate-url' });
    expect(e.contract.rendering.profiles.chromium_desktop).toMatchObject({ browser: 'chromium', browser_version: expect.stringMatching(/^\d+\./), options_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await resolveExecution(cfg(), 'preview', s)).revision).not.toBe(e.revision);
  });

  it('a frozen baseline store reads exactly the frozen version and nothing approved later', async () => {
    const inner = new FsBaselineStore(await mkdtemp(join(tmpdir(), 'qa-frozen-')));
    const key = { scenario_id: 's', checkpoint: 'c', execution_profile: 'chromium_desktop', rendering_profile: 'r' };
    const approve = async (w: number, v: number) => {
      const buf = PNG.sync.write(new PNG({ width: w, height: 2 }));
      return inner.approve(key, buf, { approved_by: 'reviewer', commit_sha: 'a'.repeat(40), source: 't', expected_sha256: createHash('sha256').update(buf).digest('hex'), expected_version: v });
    };
    const v1 = await approve(2, 0);
    const frozen = new FrozenBaselineStore(inner, [{ ...key, version: 1, sha256: v1.sha256 }]);
    await approve(3, 1);
    expect((await inner.get(key))!.record.version).toBe(2);
    expect((await frozen.get(key))!.record).toMatchObject({ version: 1, width: 2 });
    expect(await new FrozenBaselineStore(inner, []).get(key)).toBeNull();
    await expect(new FrozenBaselineStore(inner, [{ ...key, version: 1, sha256: 'f'.repeat(64) }]).get(key)).rejects.toThrow(/missing or altered/);
  });
});
