import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canaryHits, EvidenceLog, readZip, sanitizeTraceArchive, UnsupportedZip, writeZip } from '../src/index.ts';

const SECRET = 'sid-7Hq2x9Lk+/=Zz';
const TOKEN = 'fixture-token-0123456789';

describe('zip round trip', () => {
  it('reads what it writes, and the result is a standard archive', async () => {
    const entries = [
      { name: 'trace.trace', data: Buffer.from('{"a":1}\n') },
      { name: 'resources/x.html', data: Buffer.from('<p>ü</p>') },
    ];
    const zip = writeZip(entries);
    expect(readZip(zip)).toEqual(entries);
    const path = join(await mkdtemp(join(tmpdir(), 'qa-zip-')), 'a.zip');
    await writeFile(path, zip);
    const py = spawnSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))', path], { encoding: 'utf8' });
    expect(py.stdout.trim()).toBe('trace.trace,resources/x.html');
  });

  it('refuses archives it cannot fully inspect', () => {
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(UnsupportedZip);
  });
});

describe('trace sanitization', () => {
  const network = [
    JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { headers: [{ name: 'Cookie', value: `sid=${SECRET}` }, { name: 'x-qa-fixture-token', value: TOKEN }, { name: 'accept', value: 'text/html' }] }, response: { headers: [{ name: 'set-cookie', value: `sid=${SECRET}; HttpOnly` }] } } }),
    JSON.stringify({ type: 'action', params: { cookies: [{ name: 'sid', value: 'opaque-unregistered-cookie', url: 'http://x' }] } }),
  ].join('\n');

  it('blanks credential headers and cookies and removes registered secrets in every encoding', () => {
    const zip = writeZip([
      { name: 'trace.network', data: Buffer.from(network) },
      { name: 'trace.trace', data: Buffer.from(JSON.stringify({ url: `http://x/?s=${encodeURIComponent(SECRET)}`, b64: Buffer.from(SECRET).toString('base64') })) },
      { name: 'resources/page.html', data: Buffer.from(`<input value="${SECRET}">`) },
    ]);
    const s = sanitizeTraceArchive(zip, [SECRET]);
    expect(s.residualHits).toBe(0);
    const text = readZip(s.bytes).map((e) => e.data.toString()).join('\n');
    expect(canaryHits(s.bytes, [SECRET])).toBe(0);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(encodeURIComponent(SECRET));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('opaque-unregistered-cookie');
    expect(text).toContain('text/html');
    expect(s.redactedEntries.sort()).toEqual(['resources/page.html', 'trace.network', 'trace.trace']);
  });

  it('withholds an archive it cannot read instead of publishing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-log-'));
    const log = new EvidenceLog(dir, 'a1');
    await log.init();
    const path = join(dir, 'trace.zip');
    await writeFile(path, 'garbage');
    expect(await log.registerSanitizedArchive('trace', path)).toBeNull();
    await expect(readFile(path)).rejects.toThrow();
    expect(log.artifacts).toEqual([]);
  });

  it('redacts secrets from written artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-log-'));
    const log = new EvidenceLog(dir, 'a1');
    await log.init();
    log.redactor.register(SECRET);
    const ref = await log.writeArtifact('dom', 'obs.json', JSON.stringify({ value: SECRET }));
    expect(ref).not.toBeNull();
    expect(await readFile(join(dir, 'obs.json'), 'utf8')).not.toContain(SECRET);
  });
});
