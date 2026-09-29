import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Locator as PwLocator, Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { ArtifactStore } from '@qa/evidence';

export interface BaselineKey {
  scenario_id: string;
  checkpoint: string;
  execution_profile: string;
  rendering_profile: string;
}

export interface BaselineRecord {
  key: BaselineKey;
  sha256: string;
  width: number;
  height: number;
  approved_by: string;
  approved_at: string;
  commit_sha: string;
  deployment_id: string | null;
  source: string;
  version: number;
}

export interface BaselineStore {
  get(key: BaselineKey): Promise<{ record: BaselineRecord; png: Buffer } | null>;
  /** One specific approved version (integrity-checked), whatever is current now. */
  getVersion(key: BaselineKey, version: number): Promise<{ record: BaselineRecord; png: Buffer } | null>;
  /**
   * Approve `candidate` as the next version. `expected_version` is the baseline
   * version the reviewer compared against (0 when there was none); if another
   * approval landed since, the call fails with BaselineConflict (compare-and-set).
   */
  approve(key: BaselineKey, candidate: Buffer, approval: { approved_by: string; commit_sha: string; deployment_id?: string | null; source: string; expected_sha256: string; expected_version: number }): Promise<BaselineRecord>;
  list(): Promise<BaselineRecord[]>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '_');

/**
 * Filesystem baseline store. Baselines are versioned by scenario, checkpoint,
 * execution profile and rendering profile; every approval is explicit, names
 * an approver and a source commit, and keeps the prior version.
 */
export class FsBaselineStore implements BaselineStore {
  constructor(readonly dir: string) {}

  private base(k: BaselineKey) {
    return join(this.dir, safe(k.scenario_id), safe(k.checkpoint), safe(k.execution_profile), safe(k.rendering_profile));
  }

  async get(key: BaselineKey) {
    const b = this.base(key);
    try {
      const record = JSON.parse(await readFile(join(b, 'current.json'), 'utf8')) as BaselineRecord;
      const png = await readFile(join(b, `v${record.version}.png`));
      if (sha256(png) !== record.sha256) throw new Error(`baseline ${b} failed its integrity check`);
      return { record, png };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async getVersion(key: BaselineKey, version: number) {
    const b = this.base(key);
    try {
      const record = JSON.parse(await readFile(join(b, `v${version}.json`), 'utf8')) as BaselineRecord;
      const png = await readFile(join(b, `v${version}.png`));
      if (sha256(png) !== record.sha256) throw new Error(`baseline ${b} v${version} failed its integrity check`);
      return { record, png };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async approve(key: BaselineKey, candidate: Buffer, a: { approved_by: string; commit_sha: string; deployment_id?: string | null; source: string; expected_sha256: string; expected_version: number }): Promise<BaselineRecord> {
    if (!a.approved_by.trim()) throw new Error('approval requires an approver');
    if (!/^[0-9a-f]{40}$/.test(a.commit_sha)) throw new Error('approval must be tied to a full commit SHA');
    if (sha256(candidate) !== a.expected_sha256) throw new Error('candidate image does not match the checksum recorded in run evidence');
    const png = PNG.sync.read(candidate);
    const prev = await this.get(key);
    if ((prev?.record.version ?? 0) !== a.expected_version) throw new BaselineConflict(`baseline is at version ${prev?.record.version ?? 0}, not ${a.expected_version}; review the current baseline first`);
    const version = a.expected_version + 1;
    const b = this.base(key);
    await mkdir(b, { recursive: true });
    // Exclusive create claims the version: a concurrent approval of the same version fails here.
    await writeFile(join(b, `v${version}.png`), candidate, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EEXIST' ? new BaselineConflict(`version ${version} was approved concurrently`) : e;
    });
    const record: BaselineRecord = { key, sha256: a.expected_sha256, width: png.width, height: png.height, approved_by: a.approved_by, approved_at: new Date().toISOString(), commit_sha: a.commit_sha, deployment_id: a.deployment_id ?? null, source: a.source, version };
    await writeFile(join(b, `v${version}.json`), JSON.stringify(record, null, 2));
    await writeFile(join(b, 'current.json'), JSON.stringify(record, null, 2));
    return record;
  }

  async list(): Promise<BaselineRecord[]> {
    const out: BaselineRecord[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.name === 'current.json') out.push(JSON.parse(await readFile(join(d, e.name), 'utf8')));
      }
    };
    await walk(this.dir);
    return out;
  }
}

/**
 * Pinned rendering identity: a digest of everything that changes pixels for
 * identical markup — browser and version, OS, viewport, device scale factor,
 * locale, timezone, colour scheme, reduced motion and a font/rasterizer probe.
 * Baselines never compare across rendering identities; a new identity has no
 * baseline and goes to review instead of producing a spurious diff.
 */
export async function renderingProfile(page: Page): Promise<string> {
  const browser = page.context().browser();
  const env = await page
    .evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 40;
      const g = c.getContext('2d');
      let probe = 'no-canvas';
      if (g) {
        g.textBaseline = 'top';
        g.font = '16px sans-serif';
        g.fillText('Rendering probe 0123 ÅgÿÉ', 2, 2);
        g.font = '16px serif';
        g.fillText('Rendering probe', 2, 20);
        probe = c.toDataURL();
      }
      return {
        viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
        locale: navigator.language,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        probe,
      };
    })
    .catch(() => null);
  const digest = createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 12);
  return `${browser?.browserType().name() ?? 'unknown'}-${browser?.version() ?? 'unknown'}-${process.platform}-r${digest}`;
}

/** Another approval changed the baseline since the reviewer saw it (compare-and-set failure). */
export class BaselineConflict extends Error {}

/** Wait for network quiet and loaded fonts, so a capture reflects a settled view. */
export async function settleForCapture(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Wait for a stable view, then capture with animations disabled, caret hidden and declared regions masked. */
export async function captureCheckpoint(page: Page, mask: PwLocator[], fullPage: boolean): Promise<Buffer> {
  await settleForCapture(page);
  return page.screenshot({ fullPage, animations: 'disabled', caret: 'hide', mask, maskColor: '#FF00FF', scale: 'css' });
}

export interface DiffResult {
  comparable: boolean;
  diff_pixels: number;
  diff_ratio: number;
  diff_png: Buffer | null;
  /** Coarse bounding box of changed pixels (for finding deduplication). */
  bbox: { x: number; y: number; width: number; height: number } | null;
  detail: string;
}

export function compareImages(baseline: Buffer, candidate: Buffer, threshold = 0.1): DiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(candidate);
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, diff_pixels: -1, diff_ratio: 1, diff_png: null, bbox: null, detail: `dimensions changed ${a.width}×${a.height} → ${b.width}×${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: false });
  let bbox: DiffResult['bbox'] = null;
  if (n > 0) {
    let minX = a.width, minY = a.height, maxX = 0, maxY = 0;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        // pixelmatch paints differing pixels red (255, 0, 0).
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX) bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
  return { comparable: true, diff_pixels: n, diff_ratio: n / (a.width * a.height), diff_png: n > 0 ? PNG.sync.write(diff) : null, bbox, detail: `${n} differing pixels` };
}

/** Copy an approved candidate into a store from run evidence (CLI/API helper). */
export async function approveFromEvidence(store: BaselineStore, key: BaselineKey, candidatePath: string, expectedSha: string, approval: { approved_by: string; commit_sha: string; deployment_id?: string | null; source: string; expected_version: number }): Promise<BaselineRecord> {
  await stat(candidatePath);
  return store.approve(key, await readFile(candidatePath), { ...approval, expected_sha256: expectedSha });
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
}
export { copyFile };

/** Baseline store over any artifact store (filesystem or S3-compatible), under a tenant/project prefix. */
export class ArtifactBaselineStore implements BaselineStore {
  constructor(
    private readonly store: ArtifactStore,
    private readonly prefix: string,
  ) {}

  private base(k: BaselineKey) {
    return [this.prefix, safe(k.scenario_id), safe(k.checkpoint), safe(k.execution_profile), safe(k.rendering_profile)].join('/');
  }

  async get(key: BaselineKey) {
    const cur = await this.store.get(`${this.base(key)}/current.json`);
    if (!cur) return null;
    const record = JSON.parse(cur.toString('utf8')) as BaselineRecord;
    const png = await this.store.get(`${this.base(key)}/v${record.version}.png`);
    if (!png || sha256(png) !== record.sha256) throw new Error(`baseline ${this.base(key)} failed its integrity check`);
    return { record, png };
  }

  async getVersion(key: BaselineKey, version: number) {
    const meta = await this.store.get(`${this.base(key)}/v${version}.json`);
    if (!meta) return null;
    const record = JSON.parse(meta.toString('utf8')) as BaselineRecord;
    const png = await this.store.get(`${this.base(key)}/v${version}.png`);
    if (!png || sha256(png) !== record.sha256) throw new Error(`baseline ${this.base(key)} v${version} failed its integrity check`);
    return { record, png };
  }

  async approve(key: BaselineKey, candidate: Buffer, a: { approved_by: string; commit_sha: string; deployment_id?: string | null; source: string; expected_sha256: string; expected_version: number }): Promise<BaselineRecord> {
    if (!a.approved_by.trim()) throw new Error('approval requires an approver');
    if (!/^[0-9a-f]{40}$/.test(a.commit_sha)) throw new Error('approval must be tied to a full commit SHA');
    if (sha256(candidate) !== a.expected_sha256) throw new Error('candidate image does not match the checksum recorded in run evidence');
    const png = PNG.sync.read(candidate);
    const prev = await this.get(key);
    if ((prev?.record.version ?? 0) !== a.expected_version) throw new BaselineConflict(`baseline is at version ${prev?.record.version ?? 0}, not ${a.expected_version}; review the current baseline first`);
    if (await this.store.get(`${this.base(key)}/v${a.expected_version + 1}.json`)) throw new BaselineConflict(`version ${a.expected_version + 1} was approved concurrently`);
    const version = a.expected_version + 1;
    const record: BaselineRecord = { key, sha256: a.expected_sha256, width: png.width, height: png.height, approved_by: a.approved_by, approved_at: new Date().toISOString(), commit_sha: a.commit_sha, deployment_id: a.deployment_id ?? null, source: a.source, version };
    await this.store.put(`${this.base(key)}/v${version}.png`, candidate, 'image/png');
    await this.store.put(`${this.base(key)}/v${version}.json`, Buffer.from(JSON.stringify(record, null, 2)), 'application/json');
    await this.store.put(`${this.base(key)}/current.json`, Buffer.from(JSON.stringify(record, null, 2)), 'application/json');
    return record;
  }

  async list(): Promise<BaselineRecord[]> {
    const keys = (await this.store.list(this.prefix)).filter((k) => k.endsWith('/current.json'));
    return Promise.all(keys.map(async (k) => JSON.parse((await this.store.get(k))!.toString('utf8')) as BaselineRecord));
  }
}

export interface FrozenBaselineRef {
  scenario_id: string;
  checkpoint: string;
  execution_profile: string;
  rendering_profile: string;
  version: number;
  sha256: string;
}

/**
 * The baselines an execution was bound to at submission (re-audit R2).
 * Comparison reads exactly the frozen version — never whatever became current
 * later — and a checkpoint with no frozen baseline has none, even if one was
 * approved meanwhile. Approvals go to the underlying store as usual.
 */
export class FrozenBaselineStore implements BaselineStore {
  constructor(
    private readonly inner: BaselineStore,
    private readonly frozen: readonly FrozenBaselineRef[],
  ) {}

  private ref(k: BaselineKey) {
    return this.frozen.find((f) => f.scenario_id === k.scenario_id && f.checkpoint === k.checkpoint && f.execution_profile === k.execution_profile && f.rendering_profile === k.rendering_profile);
  }

  async get(key: BaselineKey) {
    const f = this.ref(key);
    if (!f) return null;
    const got = await this.inner.getVersion(key, f.version);
    if (!got || got.record.sha256 !== f.sha256) throw new Error(`frozen baseline ${key.scenario_id}/${key.checkpoint} v${f.version} is missing or altered`);
    return got;
  }

  getVersion(key: BaselineKey, version: number) {
    return this.inner.getVersion(key, version);
  }

  approve(...a: Parameters<BaselineStore['approve']>) {
    return this.inner.approve(...a);
  }

  list() {
    return this.inner.list();
  }
}
