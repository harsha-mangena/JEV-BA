import { ProviderUnavailableError } from './errors.ts';

export interface TransportOptions {
  /** Per-request timeout; always applied, even when the caller also passes a signal. */
  timeoutMs: number;
  /** Retries after the first attempt for retryable failures (network, 408, 429, 5xx). */
  retries?: number;
  /** Largest request body sent, in bytes. */
  maxRequestBytes?: number;
  /** Largest response body read, in bytes; the stream is cut and the call fails beyond it. */
  maxResponseBytes?: number;
  /** Base backoff; full jitter, capped, and never beyond the caller's deadline. */
  backoffMs?: number;
}

export interface JsonResponse {
  status: number;
  body: unknown;
  requestId: string | null;
  attempts: number;
  elapsedMs: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Invalid request built by this process: never retried, never sent. */
export class RequestRejected extends Error {}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderUnavailableError(`response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * POST JSON with every bound applied: per-attempt timeout combined with the
 * caller's cancellation/deadline signal, capped request and response sizes,
 * and bounded retries with jittered backoff that honours Retry-After but
 * never outlives the caller's signal.
 */
export async function postJson(url: string, payload: unknown, headers: Record<string, string>, o: TransportOptions, signal?: AbortSignal): Promise<JsonResponse> {
  const body = JSON.stringify(payload);
  const maxReq = o.maxRequestBytes ?? 256 * 1024;
  if (Buffer.byteLength(body) > maxReq) throw new RequestRejected(`request body ${Buffer.byteLength(body)} bytes exceeds ${maxReq}`);
  const started = Date.now();
  const retries = o.retries ?? 2;
  let last: Error = new ProviderUnavailableError('no attempt made');
  const backoff = (attempt: number, retryAfterMs: number | null) =>
    sleep(Math.min(retryAfterMs ?? Math.random() * Math.min(5_000, (o.backoffMs ?? 200) * 2 ** (attempt - 1)), 30_000), signal).catch(() => undefined);
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const cancelled = () => new ProviderUnavailableError(`cancelled: ${String(signal?.reason ?? 'aborted')}`);
    if (signal?.aborted) throw cancelled();
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs);
    let retryAfterMs: number | null = null;
    let requestId: string | null = null;
    let status = 0;
    let text: string;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'error', signal: combined });
      status = res.status;
      requestId = res.headers.get('x-typesafe-request-id') ?? res.headers.get('request-id') ?? res.headers.get('x-request-id');
      const ra = res.headers.get('retry-after');
      if (ra) retryAfterMs = /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
      text = await readCapped(res, o.maxResponseBytes ?? 1024 * 1024);
    } catch (e) {
      if (signal?.aborted) throw cancelled();
      if (e instanceof ProviderUnavailableError) throw e; // oversized response: not retryable
      // Network failure or per-attempt timeout: retryable.
      last = new ProviderUnavailableError((e as Error).name === 'TimeoutError' ? `timed out after ${o.timeoutMs} ms` : `network error: ${(e as Error).message}`);
      if (attempt <= retries) await backoff(attempt, null);
      continue;
    }
    const ref = requestId ? ` (request ${requestId})` : '';
    if (status >= 200 && status < 300) {
      try {
        return { status, body: JSON.parse(text), requestId, attempts: attempt, elapsedMs: Date.now() - started };
      } catch {
        throw new ProviderUnavailableError(`invalid JSON response${ref}`);
      }
    }
    last = new ProviderUnavailableError(`HTTP ${status}${ref}: ${text.slice(0, 200)}`);
    if (!RETRYABLE.has(status)) throw last;
    if (attempt <= retries) await backoff(attempt, retryAfterMs);
  }
  throw last;
}
