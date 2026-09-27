import { createHash } from 'node:crypto';
import type { LabeledDecision } from './labels.ts';

export type Split = 'fit' | 'select' | 'test';

/**
 * Grouped split: every decision from the same (app, journey, deployment)
 * cluster lands in the same partition, so adjacent steps of one recording
 * never straddle fitting and evaluation.
 */
export function groupedSplit(data: LabeledDecision[], ratios = { fit: 0.5, select: 0.25 }, salt = 'v1'): Record<Split, LabeledDecision[]> {
  const out: Record<Split, LabeledDecision[]> = { fit: [], select: [], test: [] };
  for (const d of data) {
    const h = createHash('sha256').update(`${salt}\u0000${clusterOf(d)}`).digest();
    const u = h.readUInt32BE(0) / 2 ** 32;
    out[u < ratios.fit ? 'fit' : u < ratios.fit + ratios.select ? 'select' : 'test'].push(d);
  }
  return out;
}

export const clusterOf = (d: Pick<LabeledDecision, 'app_id' | 'journey_id' | 'deployment_id'>) => `${d.app_id}\u0000${d.journey_id}\u0000${d.deployment_id}`;
