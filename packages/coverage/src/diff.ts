import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient } from '@qa/integrations';

const run = promisify(execFile);

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';
  previous_path?: string;
}

export type Comparison =
  | { kind: 'ok'; base: string; head: string; files: ChangedFile[] }
  /** Base is not an ancestor of head (force-push, rollback, parallel branch) or the comparison is incomplete. */
  | { kind: 'non_ancestor' | 'unavailable'; base: string | null; head: string; detail: string };

export interface DiffProvider {
  compare(base: string | null, head: string): Promise<Comparison>;
}

const STATUS: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };

/** Local git: requires the candidate repository checked out with both commits available. */
export class GitDiffProvider implements DiffProvider {
  constructor(private readonly repoDir: string) {}

  async compare(base: string | null, head: string): Promise<Comparison> {
    if (!base) return { kind: 'unavailable', base, head, detail: 'no accepted baseline deployment in this environment' };
    const git = (...args: string[]) => run('git', ['-C', this.repoDir, ...args], { maxBuffer: 32 * 1024 * 1024 });
    try {
      await git('cat-file', '-e', `${base}^{commit}`);
      await git('cat-file', '-e', `${head}^{commit}`);
    } catch {
      return { kind: 'unavailable', base, head, detail: 'baseline or candidate commit not available locally' };
    }
    try {
      await git('merge-base', '--is-ancestor', base, head);
    } catch {
      return { kind: 'non_ancestor', base, head, detail: `${base.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}` };
    }
    const { stdout } = await git('diff', '--name-status', '-M', '--no-color', base, head);
    const files = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code, a, b] = line.split('\t');
        const status = STATUS[code![0]!] ?? 'other';
        return status === 'renamed' || status === 'copied' ? { path: b!, previous_path: a!, status } : { path: a!, status };
      });
    return { kind: 'ok', base, head, files };
  }
}

/** GitHub compare API. More than 300 files means the list is truncated, so the comparison is treated as unavailable. */
export class GitHubDiffProvider implements DiffProvider {
  constructor(
    private readonly gh: GitHubClient,
    private readonly repo: string,
  ) {}

  async compare(base: string | null, head: string): Promise<Comparison> {
    if (!base) return { kind: 'unavailable', base, head, detail: 'no accepted baseline deployment in this environment' };
    let r;
    try {
      r = await this.gh.compare(this.repo, base, head);
    } catch (e) {
      return { kind: 'unavailable', base, head, detail: (e as Error).message };
    }
    if (r.status === 'diverged' || r.status === 'behind') return { kind: 'non_ancestor', base, head, detail: `comparison status ${r.status}` };
    const files = r.files ?? [];
    if (files.length >= 300) return { kind: 'unavailable', base, head, detail: 'file list truncated by the provider' };
    return {
      kind: 'ok',
      base,
      head,
      files: files.map((f) => ({ path: f.filename, status: (['added', 'modified', 'removed', 'renamed', 'copied'].includes(f.status) ? (f.status === 'removed' ? 'deleted' : f.status) : 'other') as ChangedFile['status'], ...(f.previous_filename ? { previous_path: f.previous_filename } : {}) })),
    };
  }
}
