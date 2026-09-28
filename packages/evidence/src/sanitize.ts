import { REDACTED } from './redact.ts';
import { readZip, writeZip } from './zip.ts';

/** Header names whose values are credentials regardless of content. */
export const SENSITIVE_HEADERS = ['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-qa-fixture-token'];

/** Every encoding under which a secret value could appear in captured evidence. */
export function secretForms(secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), JSON.stringify(secret).slice(1, -1)]);
  return [...forms].filter((f) => f.length >= 4);
}

function replaceAll(buf: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  let i = buf.indexOf(needle);
  if (i < 0) return buf;
  const parts: Buffer[] = [];
  let from = 0;
  while (i >= 0) {
    parts.push(buf.subarray(from, i), replacement);
    from = i + needle.length;
    i = buf.indexOf(needle, from);
  }
  parts.push(buf.subarray(from));
  return Buffer.concat(parts);
}

/** Redact known secret values (in every encoding) from arbitrary bytes. */
export function redactBytes(buf: Buffer, secrets: Iterable<string>): Buffer {
  let out = buf;
  const r = Buffer.from(REDACTED);
  for (const s of secrets) for (const f of secretForms(s)) out = replaceAll(out, Buffer.from(f), r);
  return out;
}

/** Scan bytes for any known secret value in any encoding; returns how many secrets matched (never the values). */
export function canaryHits(buf: Buffer, secrets: Iterable<string>): number {
  let hits = 0;
  for (const s of secrets) if (secretForms(s).some((f) => buf.includes(Buffer.from(f)))) hits++;
  return hits;
}

/** Redact credential-bearing header values in Playwright trace network/event JSON lines. */
function redactHeaderLines(text: string): string {
  const names = new Set(SENSITIVE_HEADERS);
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('{') || !/"headers"|"cookies"/i.test(line)) return line;
      try {
        return JSON.stringify(scrub(JSON.parse(line)));
      } catch {
        return line;
      }
    })
    .join('\n');

  function scrub(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    // Playwright stores headers as [{ name, value }] arrays and cookies as { name, value, ... } objects.
    if (typeof o.name === 'string' && typeof o.value === 'string' && names.has(o.name.toLowerCase())) return { ...o, value: REDACTED };
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (k === 'cookies' && Array.isArray(x)) out[k] = x.map((c) => (c && typeof c === 'object' ? { ...(c as object), value: REDACTED } : c));
      else if (names.has(k.toLowerCase()) && typeof x === 'string') out[k] = REDACTED;
      else out[k] = scrub(x);
    }
    return out;
  }
}

export interface SanitizedArchive {
  bytes: Buffer;
  entries: number;
  redactedEntries: string[];
  /** Secrets still detectable after sanitization; a non-zero value means the archive must be withheld. */
  residualHits: number;
  /** Image entries omitted: pixels cannot be proven free of secrets by byte redaction. */
  omittedImages: string[];
}

/** Raster/vector image content by signature (not by name: trace resources are content-addressed). */
export function isImage(b: Buffer): boolean {
  if (b.length < 4) return false;
  const head = b.subarray(0, 16).toString('latin1');
  return (
    (b[0] === 0x89 && head.slice(1, 4) === 'PNG') ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
    head.startsWith('GIF8') ||
    (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ||
    head.startsWith('BM') ||
    head.slice(4, 12) === 'ftypavif' ||
    /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.subarray(0, 256).toString('utf8'))
  );
}

/**
 * Sanitize a Playwright trace archive before it is stored or published:
 * credential headers and cookies are blanked in the network/event logs, and
 * every registered secret is removed from every entry (JSON, HTML snapshots,
 * resources) in plain, URL, base64 and JSON-escaped forms. The result is
 * re-scanned; callers must withhold the archive if anything remains.
 */
export function sanitizeTraceArchive(zip: Buffer, secrets: string[]): SanitizedArchive {
  const all = readZip(zip);
  // A trace is published as a sanitized derivative: DOM snapshots, actions and network logs (text, redacted
  // below) without any image resource — screencast frames or page images could show a secret as pixels.
  const omittedImages = all.filter((e) => isImage(e.data)).map((e) => e.name);
  const entries = all.filter((e) => !omittedImages.includes(e.name));
  const redactedEntries: string[] = [];
  const out = entries.map((e) => {
    let data = e.data;
    if (/\.(trace|network|jsonl?)$/.test(e.name)) data = Buffer.from(redactHeaderLines(data.toString('utf8')));
    data = redactBytes(data, secrets);
    if (!data.equals(e.data)) redactedEntries.push(e.name);
    return { name: e.name, data };
  });
  const bytes = writeZip(out);
  const residualHits = out.reduce((n, e) => n + canaryHits(e.data, secrets), 0) + canaryHits(bytes, secrets);
  return { bytes, entries: out.length, redactedEntries, residualHits, omittedImages };
}
