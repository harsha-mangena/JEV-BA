import { createHash, createHmac } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** S3-compatible artifact storage with tenant-scoped keys. Keys never contain `..`. */
export interface ArtifactStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<number>;
}

export function assertSafeKey(key: string): string {
  if (!key || key.startsWith('/') || key.split('/').some((p) => p === '..' || p === '.' || p === '') || /[\\\0]/.test(key)) throw new Error(`unsafe artifact key: ${key}`);
  return key;
}

export class FsArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {}
  private path(key: string) {
    return join(this.root, ...assertSafeKey(key).split('/'));
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string): Promise<Buffer | null> {
    return readFile(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
      throw e;
    });
  }
  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix);
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    if ((await stat(base).catch(() => null))?.isDirectory()) await walk(base);
    return out.sort();
  }
  async deletePrefix(prefix: string): Promise<number> {
    const n = (await this.list(prefix)).length;
    await rm(this.path(prefix), { recursive: true, force: true });
    return n;
  }
}

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Input {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
}

/** AWS Signature Version 4 (header auth). Returns the headers to send, including Authorization. */
export function signV4(i: SigV4Input): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: i.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': i.payloadHash };
  if (i.sessionToken) headers['x-amz-security-token'] = i.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalQuery = [...i.url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalPath = i.url.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const canonical = [i.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n', names.join(';'), i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export interface S3Options {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style (`endpoint/bucket/key`) for MinIO and most S3-compatible stores. */
  pathStyle?: boolean;
  prefix?: string;
}

/** Minimal S3-compatible client (PUT/GET/DELETE/ListObjectsV2) signed with SigV4. */
export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly o: S3Options) {}

  private url(key: string, query: Record<string, string> = {}): URL {
    const full = [this.o.prefix, key].filter(Boolean).join('/');
    const base = new URL(this.o.endpoint);
    const u = this.o.pathStyle !== false ? new URL(`${base.origin}/${this.o.bucket}/${full.split('/').map(enc).join('/')}`) : new URL(`${base.protocol}//${this.o.bucket}.${base.host}/${full.split('/').map(enc).join('/')}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async send(method: string, url: URL, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const payloadHash = sha256hex(body ?? '');
    const headers = signV4({ method, url, headers: extra, payloadHash, region: this.o.region, service: 's3', accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, ...(this.o.sessionToken ? { sessionToken: this.o.sessionToken } : {}), date: new Date() });
    delete headers.host;
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : null, signal: AbortSignal.timeout(30_000) });
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const r = await this.send('PUT', this.url(assertSafeKey(key)), body, { 'content-type': contentType });
    if (!r.ok) throw new Error(`S3 PUT ${key}: HTTP ${r.status}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const r = await this.send('GET', this.url(assertSafeKey(key)));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 GET ${key}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    const full = [this.o.prefix, assertSafeKey(prefix)].filter(Boolean).join('/');
    do {
      const u = this.url('', { 'list-type': '2', prefix: full, ...(token ? { 'continuation-token': token } : {}) });
      u.pathname = this.o.pathStyle !== false ? `/${this.o.bucket}` : '/';
      const r = await this.send('GET', u);
      if (!r.ok) throw new Error(`S3 LIST ${prefix}: HTTP ${r.status}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]!.slice(this.o.prefix ? this.o.prefix.length + 1 : 0));
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (const k of keys) {
      const r = await this.send('DELETE', this.url(k));
      if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${k}: HTTP ${r.status}`);
    }
    return keys.length;
  }
}

/** Upload a local run directory under a tenant-scoped prefix. */
export async function uploadDir(store: ArtifactStore, dir: string, prefix: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  for (const f of await walk(dir)) {
    await store.put(`${prefix}/${relative(dir, f).split(sep).join('/')}`, await readFile(f));
    n++;
  }
  return n;
}
