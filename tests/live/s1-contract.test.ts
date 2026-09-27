import { describe, expect, it } from 'vitest';
import { HttpS1Provider, probeRequest, TypeSafeProvider, validateResponse } from '@qa/s1';

/**
 * Live provider contract check (plan Phase 2: live smoke tests confirm the
 * documented request/response contract separately from offline tests).
 * Runs only when credentials are configured:
 *   QA_S1_PROVIDER=typesafe|http QA_S1_ENDPOINT=… QA_S1_MODEL=… QA_S1_API_KEY=… npm run test:live
 */
const kind = process.env.QA_S1_PROVIDER;
const endpoint = process.env.QA_S1_ENDPOINT;
const model = process.env.QA_S1_MODEL;

describe.skipIf(!kind || !endpoint || !model)('live System One contract', () => {
  it('answers a probe with fully valid heads and a resolved model version', async () => {
    const provider =
      kind === 'typesafe' ? new TypeSafeProvider({ endpoint: endpoint!, apiKey: process.env.QA_S1_API_KEY ?? '' }) : new HttpS1Provider('http', { endpoint: endpoint!, ...(process.env.QA_S1_API_KEY ? { apiKey: process.env.QA_S1_API_KEY } : {}) });
    const req = probeRequest(model!);
    const v = validateResponse(req, await provider.ask(req));
    expect(v.invalid).toEqual({});
    expect(v.answers.op!.selected).toBe('CLICK');
    expect(v.answers.click_target!.selected).toBe('t0');
    expect(v.resolvedModel).toBeTruthy();
  });
});
