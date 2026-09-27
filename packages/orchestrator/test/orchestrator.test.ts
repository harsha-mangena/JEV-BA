import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { originMatches } from '@qa/contracts';
import { checkCandidateUrl, checkReadiness, shard, statusFor, type RunRow } from '../src/index.ts';

const env = (patterns: string[], allow = false) => ({ url_patterns: patterns, allow_private_network: allow, required_check: true, read_only: false });

describe('URL policy', () => {
  it('wildcards never cross dots, colons or slashes', () => {
    expect(originMatches('https://pr-1.preview.example.dev', 'https://*.preview.example.dev')).toBe(true);
    expect(originMatches('https://evil.com.preview.example.dev', 'https://*.preview.example.dev')).toBe(false);
    expect(originMatches('https://pr-1.preview.example.dev.evil.com', 'https://*.preview.example.dev')).toBe(false);
    expect(originMatches('http://pr-1.preview.example.dev', 'https://*.preview.example.dev')).toBe(false);
    expect(originMatches('http://127.0.0.1:4310', 'http://127.0.0.1:*')).toBe(true);
  });

  it('refuses private destinations unless allowed, credentials and paths', async () => {
    const pub = async () => ['93.184.216.34'];
    const priv = async () => ['10.0.0.5'];
    expect(await checkCandidateUrl('https://pr-1.preview.example.dev', env(['https://*.preview.example.dev']), pub)).toEqual([]);
    expect((await checkCandidateUrl('https://pr-1.preview.example.dev', env(['https://*.preview.example.dev']), priv)).join()).toMatch(/private address/);
    expect(await checkCandidateUrl('https://pr-1.preview.example.dev', env(['https://*.preview.example.dev'], true), priv)).toEqual([]);
    expect((await checkCandidateUrl('https://u:p@pr-1.preview.example.dev', env(['https://*.preview.example.dev']), pub)).join()).toMatch(/credentials/);
    expect((await checkCandidateUrl('https://pr-1.preview.example.dev/x', env(['https://*.preview.example.dev']), pub)).join()).toMatch(/origin/);
    expect((await checkCandidateUrl('http://169.254.169.254', env(['http://*']), pub)).join()).toMatch(/private address/);
  });
});

describe('readiness', () => {
  async function server(handler: (path: string) => { status: number; body?: string; location?: string }) {
    const s = createServer((req, res) => {
      const r = handler(req.url!);
      res.writeHead(r.status, r.location ? { location: r.location } : {});
      res.end(r.body ?? '');
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
    return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
  }
  const sha = 'c'.repeat(40);

  it('requires the exact revision; an HTTP 200 alone is not ready', async () => {
    const s = await server(() => ({ status: 200, body: JSON.stringify({ commit_sha: sha }) }));
    expect((await checkReadiness(s.url, { kind: 'json', path: '/v', field: 'commit_sha' }, sha)).ready).toBe(true);
    const other = await checkReadiness(s.url, { kind: 'json', path: '/v', field: 'commit_sha' }, 'd'.repeat(40));
    expect(other).toMatchObject({ ready: false, revision_mismatch: true });
    expect((await checkReadiness(s.url, { kind: 'json', path: '/v', field: 'missing' }, sha)).ready).toBe(false);
    s.close();
  });

  it('reads a meta tag and refuses redirects', async () => {
    const s = await server((p) => (p === '/r' ? { status: 302, location: 'https://elsewhere.example' } : { status: 200, body: `<meta name="build-revision" content="${sha}">` }));
    expect((await checkReadiness(s.url, { kind: 'meta', path: '/', name: 'build-revision' }, sha)).ready).toBe(true);
    expect((await checkReadiness(s.url, { kind: 'meta', path: '/r', name: 'build-revision' }, sha)).checks[0]).toMatchObject({ check: 'no_redirect', ok: false });
    s.close();
  });
});

describe('status mapping and sharding', () => {
  const run = (state: string, gate: RunRow['gate'] = null) => ({ state, gate, message: null, reason: null }) as RunRow;
  it('only an eligible completed run is success', () => {
    expect(statusFor(run('COMPLETED', { eligible: true, reasons: [] })).state).toBe('success');
    expect(statusFor(run('COMPLETED', { eligible: false, reasons: ['x'] })).state).toBe('failure');
    for (const s of ['ERROR', 'CANCELLED', 'SUPERSEDED']) expect(statusFor(run(s)).state).toBe('error');
    for (const s of ['WAITING_READY', 'QUEUED', 'RUNNING', 'VERIFYING']) expect(statusFor(run(s)).state).toBe('pending');
  });
  it('shards deterministically without losing cases', () => {
    expect(shard([1, 2, 3, 4, 5], 2)).toEqual([[1, 3, 5], [2, 4]]);
    expect(shard([1], 4)).toEqual([[1]]);
    expect(shard([], 3)).toEqual([[]]);
  });
});
