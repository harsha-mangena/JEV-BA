import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpS1Provider, probeProvider, TYPESAFE_CONTRACT, TypeSafeProvider } from '@qa/s1';

/**
 * Live provider contract check against the real endpoint. It never passes
 * without credentials: the lane runner marks the lane BLOCKED when they are
 * absent, and with QA_REQUIRE_LIVE=1 a missing key fails here instead of
 * skipping. Mocked or skipped runs are not live verification.
 *   QA_S1_PROVIDER=typesafe QA_S1_API_KEY=… [QA_S1_MODEL=jev-latest] npm run test:live
 */
const kind = process.env.QA_S1_PROVIDER ?? (process.env.QA_S1_API_KEY ? 'typesafe' : undefined);
const ROOT = join(import.meta.dirname, '../..');

const configured = !!kind && !!process.env.QA_S1_API_KEY;

if (!configured && process.env.QA_REQUIRE_LIVE === '1') {
  it('live System One credentials are configured', () => {
    throw new Error('BLOCKED: QA_S1_API_KEY is not set; live verification cannot run');
  });
}

describe.skipIf(!configured)('live System One contract', () => {
  it('answers the probe with fully valid heads and a resolved model version', async () => {
    const endpoint = process.env.QA_S1_ENDPOINT ?? TYPESAFE_CONTRACT.endpoint;
    const model = process.env.QA_S1_MODEL ?? TYPESAFE_CONTRACT.default_model;
    const provider = kind === 'typesafe' ? new TypeSafeProvider({ endpoint, apiKey: process.env.QA_S1_API_KEY! }) : new HttpS1Provider('http', { endpoint, apiKey: process.env.QA_S1_API_KEY! });
    const rec = await probeProvider(provider, endpoint, model);
    await mkdir(join(ROOT, '.qa-work', 'evidence'), { recursive: true });
    await writeFile(join(ROOT, '.qa-work', 'evidence', 's1-compatibility.json'), `${JSON.stringify(rec, null, 2)}\n`);
    expect(rec.error).toBeUndefined();
    expect(rec.invalid_heads).toEqual({});
    expect(rec.resolved_model).toBeTruthy();
  });
});
