import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { originMatches, type EnvironmentConfig } from '@qa/contracts';

function isPrivate(ip: string): boolean {
  if (ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = v4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/**
 * A candidate URL is accepted only if it matches a configured pattern for the
 * environment and — unless the environment explicitly allows it on an
 * isolated runner — resolves exclusively to public addresses.
 */
export async function checkCandidateUrl(raw: string, env: EnvironmentConfig, resolve: Resolver = defaultResolver): Promise<string[]> {
  const problems: string[] = [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['candidate URL is not a valid URL'];
  }
  if (url.username || url.password) problems.push('candidate URL must not embed credentials');
  if (url.pathname !== '/' || url.search || url.hash) problems.push('candidate URL must be an origin (no path, query or fragment)');
  if (!env.url_patterns.some((p) => originMatches(url.origin, p))) problems.push(`origin ${url.origin} matches no configured pattern`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (addresses.length === 0) problems.push(`host ${host} does not resolve`);
  if (!env.allow_private_network && addresses.some(isPrivate)) problems.push(`host ${host} resolves to a private address`);
  return problems;
}
