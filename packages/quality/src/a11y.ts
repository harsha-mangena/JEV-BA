import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';
const ORDER: Impact[] = ['minor', 'moderate', 'serious', 'critical'];

export interface A11yViolation {
  id: string;
  impact: Impact;
  help: string;
  nodes: number;
  targets: string[];
}

/**
 * Run axe-core against the current state (WCAG 2.x A/AA tags). An empty
 * result means "no automatically detectable violations", not "accessible".
 */
export async function scanAccessibility(page: Page, opts: { disableRules?: string[] } = {}): Promise<A11yViolation[]> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (opts.disableRules?.length) builder = builder.disableRules(opts.disableRules);
  const r = await builder.analyze();
  return r.violations.map((v) => ({
    id: v.id,
    impact: (v.impact ?? 'minor') as Impact,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }));
}

export function atOrAbove(v: A11yViolation, threshold: Impact): boolean {
  return ORDER.indexOf(v.impact) >= ORDER.indexOf(threshold);
}
