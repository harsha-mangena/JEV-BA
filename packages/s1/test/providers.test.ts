import { describe, expect, it } from 'vitest';
import { CircuitBreakerProvider, FailoverProvider, probeRequest, ProviderUnavailableError, TypeSafeProvider, validateResponse, type S1Request, type SystemOneProvider } from '../src/index.ts';

const ok: SystemOneProvider = { id: 'ok', ask: async () => ({ answers: {} }) };
const failing = (n = { calls: 0 }): SystemOneProvider & { n: { calls: number } } => ({ id: 'bad', n, ask: async () => (n.calls++, Promise.reject(new Error('503'))) });

describe('circuit breaker', () => {
  it('opens after consecutive failures, fails fast, then half-opens after cooldown', async () => {
    let t = 0;
    const inner = failing();
    const cb = new CircuitBreakerProvider(inner, { failureThreshold: 2, cooldownMs: 1000, now: () => t });
    await expect(cb.ask(probeRequest('m'))).rejects.toThrow('503');
    await expect(cb.ask(probeRequest('m'))).rejects.toThrow('503');
    expect(cb.state).toBe('open');
    await expect(cb.ask(probeRequest('m'))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(inner.n.calls).toBe(2);
    t = 1500;
    expect(cb.state).toBe('half_open');
    await expect(cb.ask(probeRequest('m'))).rejects.toThrow('503');
    expect(cb.state).toBe('open');
  });

  it('closes again after a successful half-open probe', async () => {
    let t = 0;
    let fail = true;
    const cb = new CircuitBreakerProvider({ id: 'x', ask: async () => (fail ? Promise.reject(new Error('x')) : { answers: {} }) }, { failureThreshold: 1, cooldownMs: 10, now: () => t });
    await expect(cb.ask(probeRequest('m'))).rejects.toThrow();
    t = 20;
    fail = false;
    await cb.ask(probeRequest('m'));
    expect(cb.state).toBe('closed');
  });
});

describe('failover', () => {
  it('uses only secondaries certified for the current decision configuration', async () => {
    const f = new FailoverProvider([{ provider: failing(), certified_for: 'cfg' }, { provider: ok, certified_for: 'other' }], 'cfg');
    expect(f.eligible.map((p) => p.id)).toEqual(['bad']);
    await expect(f.ask(probeRequest('m'))).rejects.toThrow('503');
    const g = new FailoverProvider([{ provider: failing(), certified_for: 'cfg' }, { provider: ok, certified_for: 'cfg' }], 'cfg');
    await expect(g.ask(probeRequest('m'))).resolves.toEqual({ answers: {} });
  });
});

describe('TypeSafe codec (unverified wire format)', () => {
  const req: S1Request = probeRequest('jev-1.13');
  it('encodes typed questions over a state string with unique option texts', () => {
    const { body } = TypeSafeProvider.encode(req);
    expect(body).toMatchObject({ model: 'jev-1.13', state: expect.any(String), questions: [{ id: 'op', type: 'choice', options: ['CLICK: CLICK', 'TYPE: TYPE', 'DONE: DONE'] }, { id: 'click_target', type: 'choice' }, { id: 'form_present', type: 'noul' }] });
    expect(TypeSafeProvider.WIRE_FORMAT_VERIFIED).toBe(false);
  });

  it('decodes keyed or arrayed answers back to our keys, and malformed answers still fail validation', () => {
    const { keyMaps } = TypeSafeProvider.encode(req);
    const decoded = TypeSafeProvider.decode(
      req,
      { model: 'jev-1.13@x', answers: [{ id: 'op', probabilities: { 'CLICK: CLICK': 0.9, 'TYPE: TYPE': 0.05, 'DONE: DONE': 0.05 }, confidence: 0.8 }, { id: 'click_target', distribution: [0.97, 0.02, 0.01] }, { id: 'form_present', probability: 0.99 }] },
      keyMaps,
    );
    const v = validateResponse(req, decoded);
    expect(v.invalid).toEqual({});
    expect(v.answers.op).toMatchObject({ selected: 'CLICK', confidence: 0.8 });
    expect(v.answers.click_target!.selected).toBe('t0');
    expect(v.resolvedModel).toBe('jev-1.13@x');
    const bad = TypeSafeProvider.decode(req, { answers: { op: { probabilities: { 'CLICK: CLICK': 'high' } } } }, keyMaps);
    expect(Object.keys(validateResponse(req, bad).invalid).sort()).toEqual(['click_target', 'form_present', 'op']);
  });
});
