import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunReport } from '@qa/contracts';
import { allRoutes, normalizeRoute, type CoverageGraph } from './graph.ts';
import type { RouteUsage } from './select.ts';

async function events(runDir: string, report: RunReport): Promise<Array<{ scenario: string; path: string[]; kinds: Array<{ kind: string; summary: string; data: Record<string, unknown> }> }>> {
  const out = [];
  for (const c of report.cases) {
    const ev = c.artifacts.find((a) => a.kind === 'events');
    if (!ev) continue;
    const lines = (await readFile(join(runDir, ev.path), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    out.push({ scenario: c.scenario_id, path: lines.filter((l) => l.kind === 'navigation').map((l) => l.data.path as string), kinds: lines });
  }
  return out;
}

/** Learn observed scenario → route edges from run evidence (provenance: observed). */
export async function learnRouteUsage(runDirs: string[], graph: CoverageGraph, prior: RouteUsage = {}): Promise<RouteUsage> {
  const patterns = allRoutes(graph);
  const usage: Record<string, Set<string>> = Object.fromEntries(Object.entries(prior).map(([k, v]) => [k, new Set(v)]));
  for (const dir of runDirs) {
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport;
    for (const e of await events(dir, report)) for (const p of e.path) (usage[e.scenario] ??= new Set()).add(normalizeRoute(p, patterns));
  }
  return Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, [...v].sort()]));
}

export interface TransitionCoverage {
  declared: number;
  covered: Array<[string, string]>;
  uncovered: Array<[string, string]>;
  /** Observed transitions absent from the declared model: candidates for review, not failures. */
  undeclared: Array<[string, string]>;
}

/** State/transition coverage against the declared route model. */
export async function transitionCoverage(runDirs: string[], graph: CoverageGraph): Promise<TransitionCoverage> {
  const patterns = allRoutes(graph);
  const seen = new Set<string>();
  for (const dir of runDirs) {
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport;
    for (const e of await events(dir, report)) {
      const p = e.path.map((x) => normalizeRoute(x, patterns));
      for (let k = 1; k < p.length; k++) if (p[k] !== p[k - 1]) seen.add(`${p[k - 1]}\u0000${p[k]}`);
    }
  }
  const declared = new Set(graph.transitions.map(([a, b]) => `${a}\u0000${b}`));
  const split = (k: string) => k.split('\u0000') as [string, string];
  return {
    declared: declared.size,
    covered: [...declared].filter((k) => seen.has(k)).map(split),
    uncovered: [...declared].filter((k) => !seen.has(k)).map(split),
    undeclared: [...seen].filter((k) => !declared.has(k)).map(split),
  };
}

export interface ExplorationBoundaries {
  scenario_id: string;
  routes_visited: string[];
  controls_acted: string[];
  denied: string[];
  abstained: string[];
}

/** What an exploration actually covered — reported instead of an implied PASS for everything else. */
export async function explorationBoundaries(runDir: string, graph: CoverageGraph): Promise<ExplorationBoundaries[]> {
  const report = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as RunReport;
  const patterns = allRoutes(graph);
  return (await events(runDir, report)).map((e) => ({
    scenario_id: e.scenario,
    routes_visited: [...new Set(e.path.map((p) => normalizeRoute(p, patterns)))],
    controls_acted: e.kinds.filter((k) => k.kind === 'intent' && k.summary.startsWith('persisted:')).map((k) => k.summary.slice('persisted: '.length)),
    denied: e.kinds.filter((k) => k.kind === 'decision' && / DENY /.test(` ${k.summary} `)).map((k) => k.summary),
    abstained: e.kinds.filter((k) => k.kind === 'decision' && / (ABSTAIN|ESCALATE) /.test(` ${k.summary} `)).map((k) => k.summary),
  }));
}

export async function listRunDirs(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
}
