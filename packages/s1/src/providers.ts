import { ProviderUnavailableError } from './errors.ts';
import { postJson, type TransportOptions } from './transport.ts';
import type { S1RawAnswer, S1RawResponse, S1Request, SystemOneProvider } from './types.ts';
import { validateResponse } from './validate.ts';

export { ProviderUnavailableError };

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
    private readonly o: { endpoint: string; apiKey?: string } & Partial<TransportOptions>,
  ) {}

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const r = await postJson(this.o.endpoint, req, this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}, { timeoutMs: 20_000, ...this.o }, signal).catch((e: Error) => {
      throw e instanceof ProviderUnavailableError ? new ProviderUnavailableError(`${this.id}: ${e.message}`) : e;
    });
    return r.body as S1RawResponse;
  }
}

/** Where the TypeSafe wire contract implemented below comes from, and what has been verified. */
export const TYPESAFE_CONTRACT = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  default_model: 'jev-latest',
  source: 'Public Go client github.com/chez-shanpu/typesafeai-go (systemone.go, question.go, answer.go); the provider API reference host was not reachable from the build environment',
  request: 'POST {state, model, questions: {<key>: {type: choice|noul|score, instructions, criteria}}} with Authorization: Bearer',
  response: '{model, answers: {<key>: {type, ...}}, usage: {input_tokens, output_tokens}}; header x-typesafe-request-id',
  verified_live: false,
} as const;

type WireQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string };

/**
 * TypeSafe / Jev adapter implementing the published System One contract:
 * questions are a map keyed by caller-chosen keys; a choice question's
 * criteria map each option key to its description; a noul answer is the
 * probability that the statement is true. Question keys and option keys are
 * routing identifiers; all meaning is in the instructions and criteria.
 *
 * Offline tests pin this encoding; a live probe (`qa s1 probe`) must pass
 * against the real endpoint before the adapter is qualified for autonomy
 * (TYPESAFE_CONTRACT.verified_live stays false until then). Every response is
 * still strictly validated, so a mismatch yields invalid heads (ABSTAIN).
 */
export class TypeSafeProvider implements SystemOneProvider {
  readonly id = 'typesafe';
  static readonly WIRE_FORMAT_VERIFIED = TYPESAFE_CONTRACT.verified_live;
  /** Request id of the most recent call (support and evidence). */
  lastRequestId: string | null = null;

  constructor(private readonly o: { endpoint?: string; apiKey: string } & Partial<TransportOptions>) {}

  static encode(req: S1Request): { body: { state: unknown; model: string; questions: Record<string, WireQuestion> }; keyMaps: Record<string, Map<string, string>> } {
    const keyMaps: Record<string, Map<string, string>> = {};
    const questions: Record<string, WireQuestion> = {};
    for (const q of req.questions) {
      if (q.kind === 'noul') {
        questions[q.id] = { type: 'noul', instructions: q.prompt };
        continue;
      }
      const criteria: Record<string, string> = {};
      for (const o of q.options) criteria[o.key] = o.label;
      keyMaps[q.id] = new Map(q.options.map((o) => [o.key, o.key]));
      questions[q.id] = { type: 'choice', instructions: q.prompt, criteria };
    }
    let state: unknown = req.context;
    try {
      state = JSON.parse(req.context);
    } catch {
      /* plain-text state */
    }
    return { body: { state, model: req.model, questions }, keyMaps };
  }

  /**
   * Map the provider response into the neutral model without repairing it: an
   * answer whose type does not match the question, or whose fields are
   * missing, is passed through in a shape validation rejects.
   */
  static decode(req: S1Request, raw: unknown, _keyMaps?: Record<string, Map<string, string>>): S1RawResponse {
    const r = (raw ?? {}) as Record<string, unknown>;
    const src = r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers) ? (r.answers as Record<string, Record<string, unknown>>) : null;
    const answers: S1RawResponse['answers'] = {};
    if (!src) return { resolved_model: r.model, answers: undefined as unknown as S1RawResponse['answers'] };
    for (const [key, a] of Object.entries(src)) {
      const q = req.questions.find((x) => x.id === key);
      if (!q || !a || typeof a !== 'object') {
        answers[key] = a as unknown as S1RawAnswer;
        continue;
      }
      if (a.type !== q.kind) {
        answers[key] = { probabilities: {}, error: `answer type ${JSON.stringify(a.type)} does not match ${q.kind} question` };
        continue;
      }
      if (q.kind === 'noul') answers[key] = { probabilities: { true: a.noul } };
      else answers[key] = { probabilities: a.probabilities as Record<string, unknown>, ...(a.choice !== undefined ? { selected: a.choice } : {}), ...(a.confidence !== undefined ? { confidence: a.confidence } : {}) };
    }
    const usage = r.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return { resolved_model: r.model, answers, ...(usage ? { usage } : {}) };
  }

  async ask(req: S1Request, signal?: AbortSignal): Promise<S1RawResponse> {
    const { body } = TypeSafeProvider.encode(req);
    const r = await postJson(this.o.endpoint ?? TYPESAFE_CONTRACT.endpoint, body, { authorization: `Bearer ${this.o.apiKey}` }, { timeoutMs: 20_000, ...this.o }, signal).catch((e: Error) => {
      throw e instanceof ProviderUnavailableError ? new ProviderUnavailableError(`typesafe: ${e.message}`) : e;
    });
    this.lastRequestId = r.requestId;
    return TypeSafeProvider.decode(req, r.body);
  }
}

export interface CompatibilityRecord {
  provider: string;
  endpoint: string;
  requested_model: string;
  resolved_model: string | null;
  request_id: string | null;
  ok: boolean;
  invalid_heads: Record<string, string>;
  latency_ms: number;
  checked_at: string;
  contract_source: string;
  error?: string;
}

/**
 * Startup/qualification probe: send a tiny request and require every head to
 * validate. The record is evidence; it never enables autonomy by itself.
 */
export async function probeProvider(p: SystemOneProvider, endpoint: string, model: string, signal?: AbortSignal): Promise<CompatibilityRecord> {
  const req = probeRequest(model);
  const started = Date.now();
  const base = { provider: p.id, endpoint, requested_model: model, checked_at: new Date().toISOString(), contract_source: TYPESAFE_CONTRACT.source };
  try {
    const raw = await p.ask(req, signal);
    const v = validateResponse(req, raw);
    return { ...base, resolved_model: v.resolvedModel, request_id: (p as { lastRequestId?: string | null }).lastRequestId ?? null, ok: Object.keys(v.invalid).length === 0, invalid_heads: v.invalid, latency_ms: Date.now() - started };
  } catch (e) {
    return { ...base, resolved_model: null, request_id: null, ok: false, invalid_heads: {}, latency_ms: Date.now() - started, error: (e as Error).message };
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
