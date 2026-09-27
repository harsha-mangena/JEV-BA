import type { GitHubClient } from './github.ts';

export interface CommitStatus {
  repository: string | null;
  sha: string;
  context: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description: string;
  target_url?: string;
  /** Provider-side deployment id (for providers whose checks attach to deployments, e.g. Vercel). */
  deployment_provider_id?: string;
  provider?: string;
}

export interface StatusPublisher {
  publish(s: CommitStatus): Promise<void>;
}

export class GitHubStatusPublisher implements StatusPublisher {
  constructor(private readonly gh: GitHubClient) {}
  async publish(s: CommitStatus): Promise<void> {
    if (!s.repository) throw new Error('cannot publish a commit status without a repository binding');
    await this.gh.createCommitStatus(s.repository, s.sha, { state: s.state, context: s.context, description: s.description, ...(s.target_url ? { target_url: s.target_url } : {}) });
  }
}

/** In-memory publisher for tests and local runs. */
export class RecordingStatusPublisher implements StatusPublisher {
  readonly published: CommitStatus[] = [];
  async publish(s: CommitStatus): Promise<void> {
    this.published.push(s);
  }
  latest(sha: string, context: string): CommitStatus | undefined {
    return [...this.published].reverse().find((s) => s.sha === sha && s.context === context);
  }
}
