import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FindingCertainty } from '@qa/contracts';

export interface Finding {
  fingerprint: string;
  kind: 'visual_diff' | 'layout' | 'a11y' | 'ux_hypothesis' | 'functional';
  scenario_id: string;
  checkpoint: string;
  execution_profile: string;
  requirement_ids: string[];
  certainty: FindingCertainty;
  summary: string;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  commits: string[];
  evidence: string[];
  status: 'open' | 'accepted' | 'dismissed';
}

export type FindingInput = Omit<Finding, 'fingerprint' | 'first_seen' | 'last_seen' | 'occurrences' | 'commits' | 'evidence' | 'status'> & { signature: string; commit_sha: string | null; evidence: string };

/**
 * Deduplicating findings ledger. The fingerprint uses a coarse signature
 * (rule id, element, or a diff box snapped to a grid), so the same problem
 * seen again — including rerender noise — increments occurrences instead of
 * creating another finding.
 */
export class FindingLedger {
  private findings = new Map<string, Finding>();
  constructor(private readonly path?: string) {}

  static fingerprint(i: Pick<FindingInput, 'kind' | 'scenario_id' | 'checkpoint' | 'execution_profile' | 'signature'>): string {
    return createHash('sha256').update([i.kind, i.scenario_id, i.checkpoint, i.execution_profile, i.signature].join('\u0000')).digest('hex').slice(0, 24);
  }

  async load(): Promise<this> {
    if (!this.path) return this;
    try {
      for (const f of JSON.parse(await readFile(this.path, 'utf8')) as Finding[]) this.findings.set(f.fingerprint, f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return this;
  }

  record(i: FindingInput): { finding: Finding; created: boolean } {
    const fp = FindingLedger.fingerprint(i);
    const now = new Date().toISOString();
    const existing = this.findings.get(fp);
    if (existing) {
      existing.occurrences++;
      existing.last_seen = now;
      if (i.commit_sha && !existing.commits.includes(i.commit_sha)) existing.commits.push(i.commit_sha);
      existing.evidence = [...existing.evidence.slice(-9), i.evidence];
      if (rank(i.certainty) > rank(existing.certainty)) existing.certainty = i.certainty;
      return { finding: existing, created: false };
    }
    const { signature: _s, commit_sha, evidence, ...rest } = i;
    const f: Finding = { ...rest, fingerprint: fp, first_seen: now, last_seen: now, occurrences: 1, commits: commit_sha ? [commit_sha] : [], evidence: [evidence], status: 'open' };
    this.findings.set(fp, f);
    return { finding: f, created: true };
  }

  all(): Finding[] {
    return [...this.findings.values()];
  }

  async save(): Promise<void> {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.all(), null, 2));
  }
}

const rank = (c: FindingCertainty) => ['suspected', 'reproduced', 'confirmed'].indexOf(c);

/** Snap a diff box to a grid so sub-pixel rerender noise maps to one signature. */
export function diffSignature(bbox: { x: number; y: number; width: number; height: number } | null, grid = 64): string {
  if (!bbox) return 'dimensions';
  const s = (v: number) => Math.floor(v / grid);
  return `${s(bbox.x)},${s(bbox.y)},${s(bbox.x + bbox.width)},${s(bbox.y + bbox.height)}`;
}
