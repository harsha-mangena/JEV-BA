export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authorization|session|sid$/i;

/**
 * Redact known secret values anywhere in a structure, and values under
 * sensitive-looking keys. Applied to every evidence event before it is
 * persisted; secrets must never reach reports, traces or logs.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  register(value: string | undefined | null): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  /** Registered secret values (for byte-level redaction and canary scans; never log these). */
  values(): string[] {
    return [...this.secrets];
  }

  string(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    return out;
  }

  value<T>(v: T): T {
    return this.walk(v, undefined) as T;
  }

  private walk(v: unknown, key: string | undefined): unknown {
    if (typeof v === 'string') return key && SENSITIVE_KEY.test(key) ? REDACTED : this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, key));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, this.walk(x, k)]));
    }
    return v;
  }
}
