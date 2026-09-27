import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunReport } from '@qa/contracts';
import { approveFromEvidence, FsBaselineStore, type BaselineKey } from '@qa/quality';
import { UsageError, type ServiceArgs } from './service.ts';

interface Pending {
  key: BaselineKey;
  path: string;
  sha256: string;
  scenario: string;
  profile: string;
}

async function pendingIn(runDir: string): Promise<{ report: RunReport; items: Pending[] }> {
  const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as RunReport;
  const items: Pending[] = [];
  for (const c of report.cases) {
    for (const a of c.assertions) {
      if (a.type !== 'visual_match' || a.status !== 'needs_review') continue;
      const key = (a.expected as { key?: BaselineKey })?.key;
      const art = /artifact: (\S+)#sha256=([0-9a-f]{64})/.exec(a.message ?? '');
      if (!key || !art) continue;
      items.push({ key, path: join(runDir, art[1]!), sha256: art[2]!, scenario: c.scenario_id, profile: c.execution_profile });
    }
  }
  return { report, items };
}

export async function pending(a: ServiceArgs): Promise<number> {
  if (!a.run) throw new UsageError('--run is required');
  const { items } = await pendingIn(resolve(a.run as string));
  for (const i of items) console.log(`${i.scenario}\t${i.profile}\t${i.key.checkpoint}\t${i.key.rendering_profile}\t${i.path}`);
  if (!items.length) console.log('no visual checkpoints awaiting approval');
  return 0;
}

/** Explicit human approval: names an approver and the commit the candidate came from. Never automatic. */
export async function approve(a: ServiceArgs): Promise<number> {
  if (!a.run || !a.approver || !a['commit-sha']) throw new UsageError('--run, --approver and --commit-sha are required');
  const store = new FsBaselineStore(resolve(a.baselines as string));
  const { report, items } = await pendingIn(resolve(a.run as string));
  for (const i of items) {
    const r = await approveFromEvidence(store, i.key, i.path, i.sha256, { approved_by: a.approver as string, commit_sha: a['commit-sha'] as string, deployment_id: report.deployment_id, source: `${report.run_id}` });
    console.log(`approved ${i.scenario}/${i.key.checkpoint}/${i.profile} v${r.version}`);
  }
  return 0;
}

export async function list(a: ServiceArgs): Promise<number> {
  for (const r of await new FsBaselineStore(resolve(a.baselines as string)).list()) {
    console.log(`${r.key.scenario_id}/${r.key.checkpoint}/${r.key.execution_profile}\tv${r.version}\t${r.key.rendering_profile}\t${r.approved_by}\t${r.commit_sha.slice(0, 12)}`);
  }
  return 0;
}
