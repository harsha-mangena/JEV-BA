import { createHash } from 'node:crypto';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import type { FixtureCatalog, ProjectPolicy } from '@qa/contracts';
import type { CoverageGraph } from './graph.ts';
import { validateProposal } from './proposals.ts';

/**
 * Promote a validated proposal from `<specs>/proposals/<id>.yaml` into
 * `<specs>/scenarios/<id>.yaml` and append an approval record. Existing
 * approved scenarios are never overwritten here (changes go through repair
 * review). The suite revision changes, invalidating earlier results.
 */
export async function approveProposalFile(specsDir: string, id: string, approver: string, ctx: { graph: CoverageGraph; catalog: FixtureCatalog; policy: ProjectPolicy }): Promise<{ path: string; sha256: string; source: string }> {
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(id)) throw new Error('invalid proposal id');
  if (!approver.trim()) throw new Error('approval requires an approver');
  const raw = parseYaml(await readFile(join(specsDir, 'proposals', `${id}.yaml`), 'utf8')) as { source: string; scenario: unknown; oracles: unknown };
  const v = validateProposal(raw, ctx);
  if (!v.ok) throw new Error(`invalid proposal: ${v.errors.join('; ')}`);
  if (v.scenario.id !== id) throw new Error('proposal file name and scenario id differ');
  const target = join(specsDir, 'scenarios', `${id}.yaml`);
  if (await access(target).then(() => true, () => false)) throw new Error(`${id} is already an approved scenario`);
  const text = stringify(raw.scenario);
  await writeFile(target, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  await appendFile(join(specsDir, 'approvals.jsonl'), `${JSON.stringify({ scenario_id: id, source: raw.source, approver, approved_at: new Date().toISOString(), sha256, oracles: raw.oracles })}\n`);
  return { path: target, sha256, source: raw.source };
}
