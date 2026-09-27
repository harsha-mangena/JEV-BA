export interface PollResult<T> {
  ok: boolean;
  value: T;
  elapsed_ms: number;
}

/**
 * Retry a read-only probe until it is satisfied or the deadline passes.
 * Only ever used for observation/assertion — never to repeat an action.
 */
export async function pollUntil<T>(probe: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, intervalMs = 100): Promise<PollResult<T>> {
  const start = Date.now();
  let value = await probe();
  while (!done(value)) {
    if (Date.now() - start >= timeoutMs) return { ok: false, value, elapsed_ms: Date.now() - start };
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await probe();
  }
  return { ok: true, value, elapsed_ms: Date.now() - start };
}
