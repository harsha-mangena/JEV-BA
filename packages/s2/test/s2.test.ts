import { describe, expect, it } from 'vitest';
import type { Observation } from '@qa/contracts';
import { validateS2Proposal } from '../src/index.ts';

const obs = { candidates: [{ node_id: 'n1' }] } as unknown as Observation;

describe('S2 proposals', () => {
  it('accepts an observed target', () => {
    expect(validateS2Proposal({ kind: 'SELECT_OBSERVED_TARGET', node_id: 'n1', evidence_refs: ['section:Checkout'], reason: 'primary action in checkout form' }, obs).ok).toBe(true);
  });
  it('rejects targets outside the observation', () => {
    expect(validateS2Proposal({ kind: 'SELECT_OBSERVED_TARGET', node_id: 'n9', evidence_refs: [], reason: '' }, obs)).toMatchObject({ ok: false });
  });
  it('rejects selectors, scripts, permission or assertion changes', () => {
    for (const extra of [{ selector: '#buy' }, { javascript: 'document.forms[0].submit()' }, { grant: 'test_owned_order_create' }, { assertions: [] }]) {
      expect(validateS2Proposal({ kind: 'SELECT_OBSERVED_TARGET', node_id: 'n1', evidence_refs: [], reason: '', ...extra }, obs).ok).toBe(false);
    }
    expect(validateS2Proposal({ kind: 'RUN_SHELL', cmd: 'rm -rf /' }, obs).ok).toBe(false);
  });
});
