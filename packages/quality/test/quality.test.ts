import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareImages, diffSignature, FindingLedger } from '../src/index.ts';

function png(w: number, h: number, paint?: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      const i = (y * w + x) * 4;
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}

describe('image comparison', () => {
  it('identical images have no diff', () => {
    expect(compareImages(png(20, 20), png(20, 20))).toMatchObject({ comparable: true, diff_pixels: 0, diff_png: null, bbox: null });
  });
  it('reports a bounding box around changed pixels', () => {
    const d = compareImages(png(40, 40), png(40, 40, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 8 ? [0, 0, 0] : [255, 255, 255])));
    expect(d.diff_pixels).toBe(30);
    expect(d.bbox).toEqual({ x: 10, y: 5, width: 10, height: 3 });
    expect(d.diff_ratio).toBeCloseTo(30 / 1600);
  });
  it('dimension changes are not comparable and count as a full difference', () => {
    expect(compareImages(png(10, 10), png(10, 12))).toMatchObject({ comparable: false, diff_ratio: 1 });
  });
});

describe('findings ledger', () => {
  const base = { kind: 'visual_diff' as const, scenario_id: 's', checkpoint: 'c', execution_profile: 'p', requirement_ids: ['R-1'], certainty: 'suspected' as const, summary: 'x', evidence: 'e' };
  it('snaps nearby diff boxes to one signature', () => {
    expect(diffSignature({ x: 10, y: 10, width: 20, height: 5 })).toBe(diffSignature({ x: 12, y: 11, width: 20, height: 6 }));
    expect(diffSignature({ x: 10, y: 10, width: 20, height: 5 })).not.toBe(diffSignature({ x: 300, y: 10, width: 20, height: 5 }));
  });
  it('deduplicates by fingerprint and escalates certainty monotonically', () => {
    const l = new FindingLedger();
    expect(l.record({ ...base, signature: 'a', commit_sha: 'c1' }).created).toBe(true);
    expect(l.record({ ...base, signature: 'a', commit_sha: 'c2', certainty: 'reproduced' }).created).toBe(false);
    l.record({ ...base, signature: 'a', commit_sha: 'c2' });
    expect(l.record({ ...base, signature: 'b', commit_sha: null }).created).toBe(true);
    const [first] = l.all();
    expect(first).toMatchObject({ occurrences: 3, commits: ['c1', 'c2'], certainty: 'reproduced' });
    expect(l.all()).toHaveLength(2);
  });
});
