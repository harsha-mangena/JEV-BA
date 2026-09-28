import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const inv = JSON.parse(readFileSync(join(import.meta.dirname, '../../../docs/acceptance-inventory.json'), 'utf8')) as {
  states: string[];
  items: Array<{ id: string; state: string; tests: string[]; lanes: string[]; external_prerequisite: string | null; evidence?: string[] }>;
};

describe('acceptance inventory', () => {
  it('uses only the declared readiness states and covers every audit finding', () => {
    expect(inv.states).toEqual(['IMPLEMENTATION_PENDING', 'IMPLEMENTED_OFFLINE_VERIFIED', 'LIVE_VERIFICATION_REQUIRED', 'QUALIFIED_FOR_PROFILE', 'BLOCKED']);
    for (const i of inv.items) expect(inv.states, i.id).toContain(i.state);
    for (const id of ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'CONC']) expect(inv.items.map((i) => i.id)).toContain(id);
  });

  it('never claims qualification without evidence, and never claims offline verification without tests', () => {
    for (const i of inv.items) {
      if (i.state === 'QUALIFIED_FOR_PROFILE') expect(i.evidence?.length, i.id).toBeGreaterThan(0);
      if (i.state !== 'IMPLEMENTATION_PENDING' && i.state !== 'BLOCKED') expect(i.tests.length, i.id).toBeGreaterThan(0);
      if (i.state === 'QUALIFIED_FOR_PROFILE') expect(i.external_prerequisite, i.id).toBeNull();
    }
  });

  it('references only test files that exist', () => {
    for (const i of inv.items) for (const t of i.tests) expect(existsSync(join(import.meta.dirname, '../../..', t.split('#')[0]!)), `${i.id}: ${t}`).toBe(true);
  });
});
