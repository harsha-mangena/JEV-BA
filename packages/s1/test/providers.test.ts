import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CircuitBreakerProvider, FailoverProvider, probeProvider, probeRequest, ProviderUnavailableError, RequestRejected, TYPESAFE_CONTRACT, TypeSafeProvider, validateResponse, type S1Request, type SystemOneProvider } from '../src/index.ts';

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

describe('TypeSafe System One contract', () => {
  const req: S1Request = probeRequest('jev-latest');

  it('encodes questions as a keyed map with instructions and per-option criteria over structured state', () => {
    const { body } = TypeSafeProvider.encode(req);
    expect(body).toEqual({
      model: 'jev-latest',
      state: { note: 'contract probe', page: 'A form with a single button labelled "Submit order".' },
      questions: {
        op: { type: 'choice', instructions: 'Which operation submits the order?', criteria: { CLICK: 'CLICK', TYPE: 'TYPE', DONE: 'DONE' } },
        click_target: { type: 'choice', instructions: 'Assuming the next operation is CLICK, which element?', criteria: { t0: 'button "Submit order"', NONE: 'None', NEED_MORE_CONTEXT: 'Cannot decide' } },
        form_present: { type: 'noul', instructions: 'Is there a form on the page?' },
      },
    });
    expect(TYPESAFE_CONTRACT.verified_live).toBe(false);
  });

  it('decodes official choice and noul answers and reports the resolved model', () => {
    const decoded = TypeSafeProvider.decode(req, {
      model: 'jev-1.13.0',
      answers: {
        op: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.9, TYPE: 0.05, DONE: 0.05 }, confidence: 0.8 },
        click_target: { type: 'choice', choice: 't0', probabilities: { t0: 0.97, NONE: 0.02, NEED_MORE_CONTEXT: 0.01 }, confidence: 0.9 },
        form_present: { type: 'noul', noul: 0.99 },
      },
      usage: { input_tokens: 120, output_tokens: 9 },
    });
    const v = validateResponse(req, decoded);
    expect(v.invalid).toEqual({});
    expect(v.answers.op).toMatchObject({ selected: 'CLICK', confidence: 0.8 });
    expect(v.answers.click_target!.selected).toBe('t0');
    expect(v.answers.form_present!.distribution.true).toBe(0.99);
    expect(v.resolvedModel).toBe('jev-1.13.0');
    expect(decoded.usage).toEqual({ input_tokens: 120, output_tokens: 9 });
  });

  it('never repairs a non-conforming answer', () => {
    const bad = TypeSafeProvider.decode(req, {
      model: 'jev',
      answers: {
        op: { type: 'noul', noul: 0.9 },
        click_target: { type: 'choice', choice: 'NONE', probabilities: { t0: 0.9, NONE: 0.1, NEED_MORE_CONTEXT: 0 } },
        form_present: { type: 'noul', probability: 0.99 },
        extra: { type: 'noul', noul: 0.5 },
      },
    });
    const v = validateResponse(req, bad);
    expect(v.invalid.op).toMatch(/does not match choice question/);
    expect(v.invalid.click_target).toMatch(/not a maximal-probability option/);
    expect(v.invalid.form_present).toBe('invalid noul probability');
    expect(v.invalid.extra).toBe('answer for a question that was not asked');
    // The earlier, guessed array format is no longer accepted.
    expect(Object.keys(validateResponse(req, TypeSafeProvider.decode(req, { answers: [{ id: 'op' }] })).invalid).sort()).toEqual(['click_target', 'form_present', 'op']);
  });
});

type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void;
async function server(handler: Handler): Promise<{ url: string; calls: () => number; bodies: unknown[]; close: () => Promise<void> }> {
  let n = 0;
  const bodies: unknown[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString() || 'null'));
      handler(req, res, ++n);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/systemone`, calls: () => n, bodies, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) };
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const answer = { model: 'jev-1.13.0', answers: { op: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 1, TYPE: 0, DONE: 0 }, confidence: 1 }, click_target: { type: 'choice', choice: 't0', probabilities: { t0: 1, NONE: 0, NEED_MORE_CONTEXT: 0 }, confidence: 1 }, form_present: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } };

describe('bounded provider transport (audit F08)', () => {
  it('sends the bearer key and captures the request id; the probe record validates every head', async () => {
    const s = await server((req, res) => json(res, 200, req.headers.authorization === 'Bearer k' ? answer : {}, { 'x-typesafe-request-id': 'req_123' }));
    try {
      const p = new TypeSafeProvider({ endpoint: s.url, apiKey: 'k', timeoutMs: 2_000 });
      const rec = await probeProvider(p, s.url, 'jev-latest');
      expect(rec).toMatchObject({ ok: true, resolved_model: 'jev-1.13.0', request_id: 'req_123', invalid_heads: {} });
      expect((s.bodies[0] as { questions: Record<string, unknown> }).questions).toHaveProperty('op.criteria.CLICK');
    } finally {
      await s.close();
    }
  });

  it('applies its own timeout even when the caller supplies a signal', async () => {
    const s = await server((_q, res) => setTimeout(() => json(res, 200, answer), 500));
    try {
      const p = new TypeSafeProvider({ endpoint: s.url, apiKey: 'k', timeoutMs: 30, retries: 0 });
      const t0 = Date.now();
      await expect(p.ask(req0(), new AbortController().signal)).rejects.toThrow(/timed out after 30 ms/);
      expect(Date.now() - t0).toBeLessThan(400);
    } finally {
      await s.close();
    }
  });

  it('stops immediately, without further retries, when the caller cancels', async () => {
    const s = await server((_q, res) => setTimeout(() => json(res, 503, {}), 50));
    try {
      const ac = new AbortController();
      const p = new TypeSafeProvider({ endpoint: s.url, apiKey: 'k', timeoutMs: 5_000, retries: 5, backoffMs: 200 });
      setTimeout(() => ac.abort('run cancelled'), 120);
      await expect(p.ask(req0(), ac.signal)).rejects.toThrow(/cancelled/);
      expect(s.calls()).toBeLessThanOrEqual(2);
    } finally {
      await s.close();
    }
  });

  it('retries 429/5xx (honouring Retry-After) but never other 4xx', async () => {
    const flaky = await server((_q, res, n) => (n === 1 ? json(res, 429, { error: 'slow down' }, { 'retry-after': '0' }) : n === 2 ? json(res, 503, {}) : json(res, 200, answer)));
    const denied = await server((_q, res) => json(res, 401, { error: 'bad key' }));
    try {
      const r = await new TypeSafeProvider({ endpoint: flaky.url, apiKey: 'k', timeoutMs: 2_000, retries: 3, backoffMs: 1 }).ask(req0());
      expect(r.resolved_model).toBe('jev-1.13.0');
      expect(flaky.calls()).toBe(3);
      await expect(new TypeSafeProvider({ endpoint: denied.url, apiKey: 'k', timeoutMs: 2_000, retries: 3, backoffMs: 1 }).ask(req0())).rejects.toThrow(/HTTP 401/);
      expect(denied.calls()).toBe(1);
    } finally {
      await flaky.close();
      await denied.close();
    }
  });

  it('caps response and request sizes', async () => {
    const big = await server((_q, res) => json(res, 200, { pad: 'x'.repeat(4096), ...answer }));
    try {
      await expect(new TypeSafeProvider({ endpoint: big.url, apiKey: 'k', timeoutMs: 2_000, maxResponseBytes: 1024 }).ask(req0())).rejects.toThrow(/exceeded 1024 bytes/);
      const huge: S1Request = { ...req0(), context: 'y'.repeat(10_000) };
      await expect(new TypeSafeProvider({ endpoint: big.url, apiKey: 'k', timeoutMs: 2_000, maxRequestBytes: 4096 }).ask(huge)).rejects.toBeInstanceOf(RequestRejected);
      expect(big.calls()).toBe(1);
    } finally {
      await big.close();
    }
  });
});

function req0(): S1Request {
  return probeRequest('jev-latest');
}
