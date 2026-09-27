import { isAbsolute, resolve } from 'node:path';
import { loadCoverageGraph, selectImpacted, type DiffProvider, type RouteUsage } from '@qa/coverage';
import type { SelectionManifest } from '@qa/contracts';
import type { SelectionContext } from './service.ts';
import { selectFullSuite } from './suite.ts';

/**
 * Change-aware selection for projects that declare a coverage graph. Without a
 * graph or a diff provider the full suite runs; with them, impact analysis
 * still broadens to the full suite whenever the comparison is uncertain.
 */
export function impactSelector(opts: { baseDir: string; diffFor(ctx: SelectionContext): DiffProvider | null; usageFor?(ctx: SelectionContext): Promise<RouteUsage> }) {
  return async (ctx: SelectionContext): Promise<SelectionManifest> => {
    const file = ctx.project.config.suite.coverage_file;
    const diff = opts.diffFor(ctx);
    if (!file || !diff) return selectFullSuite(ctx.suite, ctx.project.config, ctx.environment, ctx.commit_sha, file ? 'no diff provider' : 'no coverage graph');
    const graph = await loadCoverageGraph(isAbsolute(file) ? file : resolve(opts.baseDir, file));
    return selectImpacted({
      graph,
      scenarios: ctx.suite.scenarios,
      environment: ctx.environment,
      ...(ctx.project.config.suite.profiles ? { profiles: ctx.project.config.suite.profiles } : {}),
      suite_revision: ctx.suite.revision,
      candidate_sha: ctx.commit_sha,
      comparison: await diff.compare(ctx.baseline_sha, ctx.commit_sha),
      usage: (await opts.usageFor?.(ctx)) ?? {},
    });
  };
}
