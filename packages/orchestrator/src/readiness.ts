import type { VersionCheck } from '@qa/contracts';

export interface ReadinessResult {
  ready: boolean;
  /** True when the target answered but reports a different revision: waiting will not help. */
  revision_mismatch: boolean;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
}

async function get(url: string): Promise<Response> {
  // Redirects are never followed: a redirect to another origin must not satisfy readiness.
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } });
}

/**
 * Readiness is more than HTTP 200: the target must be reachable without
 * redirecting elsewhere and must report exactly the verified revision.
 */
export async function checkReadiness(baseUrl: string, v: VersionCheck, expectedSha: string): Promise<ReadinessResult> {
  const checks: ReadinessResult['checks'] = [];
  const url = new URL(v.path, baseUrl).toString();
  let res: Response;
  try {
    res = await get(url);
  } catch (e) {
    return { ready: false, revision_mismatch: false, checks: [{ check: 'reachable', ok: false, detail: (e as Error).message }] };
  }
  if (res.status >= 300 && res.status < 400) {
    return { ready: false, revision_mismatch: false, checks: [{ check: 'no_redirect', ok: false, detail: `redirect to ${res.headers.get('location') ?? '?'}` }] };
  }
  checks.push({ check: 'reachable', ok: res.status < 500, detail: `HTTP ${res.status}` });
  if (res.status >= 500 || res.status === 404) return { ready: false, revision_mismatch: false, checks };
  const text = await res.text();
  let reported: string | null = null;
  if (v.kind === 'json') {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      reported = typeof body[v.field] === 'string' ? (body[v.field] as string) : null;
    } catch {
      reported = null;
    }
  } else {
    const re = new RegExp(`<meta[^>]+name=["']${v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']+)["']`, 'i');
    reported = text.match(re)?.[1] ?? null;
  }
  checks.push({ check: 'revision_reported', ok: reported !== null, detail: reported ?? 'not found' });
  if (reported === null) return { ready: false, revision_mismatch: false, checks };
  const match = reported === expectedSha;
  checks.push({ check: 'revision_matches', ok: match, detail: `expected ${expectedSha}, reported ${reported}` });
  return { ready: match, revision_mismatch: !match, checks };
}

/** The revision the target currently reports via the project's version check, or null. */
export async function readRevision(baseUrl: string, v: VersionCheck): Promise<string | null> {
  const r = await checkReadiness(baseUrl, v, '\u0000');
  const reported = r.checks.find((c) => c.check === 'revision_reported');
  return reported?.ok ? (reported.detail ?? null) : null;
}
