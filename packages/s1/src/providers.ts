import type { ChoiceQuestion, S1RawAnswer, S1RawResponse, S1Request, SystemOneProvider } from './types.ts';

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Circuit breaker: after `failureThreshold` consecutive failures the circuit
 * opens and requests fail fast for `cooldownMs`; one half-open probe then
 * decides whether to close it. A tripped provider yields ERROR
 * (provider_unavailable), never FAIL or PASS.
 */
export class CircuitBreakerProvider implements SystemOneProvider {
  private failures = 0;
  private openedAt: number | null = null;
  private halfOpenInFlight = false;

  constructor(
    private readonly inner: SystemOneProvider,
    private readonly o: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {},
  ) {}

  get id() {
    return this.inner.id;
  }

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= (this.o.cooldownMs ?? 30_000) ? 'half_open' : 'open';
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const st = this.state;
    if (st === 'open' || (st === 'half_open' && this.halfOpenInFlight)) throw new ProviderUnavailableError(`circuit open for ${this.inner.id}`);
    if (st === 'half_open') this.halfOpenInFlight = true;
    try {
      const r = await this.inner.ask(req, signal);
      this.failures = 0;
      this.openedAt = null;
      return r;
    } catch (e) {
      this.failures++;
      if (st === 'half_open' || this.failures >= (this.o.failureThreshold ?? 5)) this.openedAt = this.now();
      throw e;
    } finally {
      if (st === 'half_open') this.halfOpenInFlight = false;
    }
  }
}

export interface CertifiedProvider {
  provider: SystemOneProvider;
  /** Decision-configuration digest this provider passed the evaluation suite for. */
  certified_for: string | null;
}

/**
 * Failover only to providers certified (by the same evaluation suite) for the
 * current decision configuration. An uncertified secondary is never used:
 * "System One" is a role, not a guarantee of interchangeable behaviour.
 */
export class FailoverProvider implements SystemOneProvider {
  readonly id: string;
  constructor(
    private readonly chain: CertifiedProvider[],
    private readonly decisionDigest: string,
  ) {
    this.id = `failover(${chain.map((c) => c.provider.id).join('>')})`;
  }

  get eligible(): SystemOneProvider[] {
    return this.chain.filter((c, i) => i === 0 || c.certified_for === this.decisionDigest).map((c) => c.provider);
  }

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    let last: unknown;
    for (const p of this.eligible) {
      try {
        return await p.ask(req, signal);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new ProviderUnavailableError('no provider available');
  }
}

/** Provider speaking this project's own neutral S1 JSON contract (e.g. a self-hosted adapter or proxy). */
export class HttpS1Provider implements SystemOneProvider {
  constructor(
    readonly id: string,
    private readonly o: { endpoint: string; apiKey?: string; timeoutMs?: number },
  ) {}

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const res = await fetch(this.o.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify(req),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new ProviderUnavailableError(`${this.id}: HTTP ${res.status}`);
    return (await res.json()) as S1RawResponse;
  }
}

/**
 * TypeSafe / Jev adapter.
 *
 * UNVERIFIED WIRE FORMAT. The request/response field names below are derived
 * from public descriptions (state + typed questions; Choice returns a
 * probability per option and a confidence; Noul returns the probability that
 * a statement is true; up to 255 Choice options) — the provider's API
 * reference could not be read from the build environment. Run
 * `qa s1 probe` against the live endpoint before enabling autonomy; every
 * response still goes through strict validation, so a mismatch surfaces as
 * invalid heads (ABSTAIN), never as an action.
 */
export class TypeSafeProvider implements SystemOneProvider {
  readonly id = 'typesafe';
  static readonly WIRE_FORMAT_VERIFIED = false;

  constructor(private readonly o: { endpoint: string; apiKey: string; timeoutMs?: number }) {}

  static encode(req: S1Request): { body: unknown; keyMaps: Record<string, Map<string, string>> } {
    const keyMaps: Record<string, Map<string, string>> = {};
    const questions = req.questions.map((q) => {
      if (q.kind === 'noul') return { id: q.id, type: 'noul', question: q.prompt };
      const labels = new Map<string, string>();
      const options = (q as ChoiceQuestion).options.map((o) => {
        const text = `${o.key}: ${o.label}`;
        labels.set(text, o.key);
        labels.set(o.key, o.key);
        return text;
      });
      keyMaps[q.id] = labels;
      return { id: q.id, type: 'choice', question: q.prompt, options };
    });
    return { body: { model: req.model, state: req.context, questions }, keyMaps };
  }

  static decode(req: S1Request, raw: unknown, keyMaps: Record<string, Map<string, string>>): S1RawResponse {
    const r = (raw ?? {}) as Record<string, unknown>;
    const list: Array<Record<string, unknown>> = Array.isArray(r.answers)
      ? (r.answers as Array<Record<string, unknown>>)
      : Object.entries((r.answers ?? {}) as Record<string, Record<string, unknown>>).map(([id, a]) => ({ id, ...a }) as Record<string, unknown>);
    const answers: S1RawResponse['answers'] = {};
    for (const a of list) {
      const id = String(a.id ?? a.question_id ?? '');
      const q = req.questions.find((x) => x.id === id);
      if (!q) {
        answers[id] = a as unknown as S1RawAnswer;
        continue;
      }
      if (q.kind === 'noul') {
        answers[id] = { probabilities: { true: (a.probability ?? a.p ?? (a.probabilities as Record<string, unknown> | undefined)?.true) as unknown } };
        continue;
      }
      const map = keyMaps[id]!;
      const src = (a.probabilities ?? a.distribution ?? {}) as Record<string, unknown> | unknown[];
      const probabilities: Record<string, unknown> = {};
      if (Array.isArray(src)) q.options.forEach((o, i) => (probabilities[o.key] = src[i]));
      else for (const [k, v] of Object.entries(src)) probabilities[map.get(k) ?? k] = v;
      const selected = a.selected ?? a.answer ?? a.choice;
      answers[id] = { probabilities, ...(selected !== undefined ? { selected: map.get(String(selected)) ?? selected } : {}), ...(a.confidence !== undefined ? { confidence: a.confidence } : {}) };
    }
    return { resolved_model: r.model ?? r.resolved_model, answers, ...(r.usage ? { usage: r.usage as S1RawResponse['usage'] } : {}) };
  }

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const { body, keyMaps } = TypeSafeProvider.encode(req);
    const res = await fetch(this.o.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new ProviderUnavailableError(`typesafe: HTTP ${res.status}`);
    return TypeSafeProvider.decode(req, await res.json(), keyMaps);
  }
}

/** Live contract probe: a tiny request whose answer must validate. */
export function probeRequest(model: string): S1Request {
  return {
    model,
    context: JSON.stringify({ note: 'contract probe', page: 'A form with a single button labelled "Submit order".' }),
    questions: [
      { id: 'op', kind: 'choice', prompt: 'Which operation submits the order?', options: [{ key: 'CLICK', label: 'CLICK' }, { key: 'TYPE', label: 'TYPE' }, { key: 'DONE', label: 'DONE' }] },
      { id: 'click_target', kind: 'choice', prompt: 'Assuming the next operation is CLICK, which element?', options: [{ key: 't0', label: 'button "Submit order"' }, { key: 'NONE', label: 'None' }, { key: 'NEED_MORE_CONTEXT', label: 'Cannot decide' }] },
      { id: 'form_present', kind: 'noul', prompt: 'Is there a form on the page?' },
    ],
  };
}
