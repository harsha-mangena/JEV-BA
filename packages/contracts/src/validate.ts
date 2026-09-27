import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { parseRef, type ValidationIssue } from './common.ts';
import { FixtureCatalog } from './fixtures.ts';
import { ProjectPolicy } from './policy.ts';
import { Scenario } from './scenario.ts';

export class ContractError extends Error {
  constructor(
    readonly source: string,
    readonly issues: ValidationIssue[],
  ) {
    super(`${source}: ${issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ')}`);
    this.name = 'ContractError';
  }
}

function zodIssues(err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown, source: string): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ContractError(source, zodIssues(r.error));
  return r.data;
}

export async function loadYaml<T extends z.ZodTypeAny>(schema: T, path: string): Promise<z.output<T>> {
  const text = await readFile(path, 'utf8');
  return parseWith(schema, parseYaml(text), path);
}

export const loadScenario = (path: string) => loadYaml(Scenario, path);
export const loadPolicy = (path: string) => loadYaml(ProjectPolicy, path);
export const loadFixtureCatalog = (path: string) => loadYaml(FixtureCatalog, path);

/**
 * Cross-document checks that a schema alone cannot express (plan §5.2 and
 * Phase 0 acceptance): every reference resolves, the origin profile and
 * mutations are known, secrets never flow into assertions, and exploration
 * scenarios do not smuggle in scripted steps.
 */
export function validateScenarioSemantics(s: Scenario, catalog: FixtureCatalog, policy: ProjectPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fx = catalog.fixtures[s.fixture];
  if (!fx) issues.push({ path: 'fixture', message: `unknown fixture ${s.fixture}` });
  else if (fx.role !== s.role) issues.push({ path: 'role', message: `fixture ${s.fixture} provisions role ${fx.role}, not ${s.role}` });

  const checkRef = (path: string, ref: string | undefined, allowSecret: boolean) => {
    if (ref === undefined) return;
    const { scope, field } = parseRef(ref);
    if (scope === 'secret' && !allowSecret) {
      issues.push({ path, message: `secret reference ${ref} is not allowed here (assertion values are recorded in evidence)` });
      return;
    }
    if (!fx) return;
    const known = scope === 'fixture' ? fx.fields : fx.secrets;
    if (!known.includes(field)) issues.push({ path, message: `${ref} does not resolve in fixture ${s.fixture}` });
  };

  if (!policy.origin_profiles[s.policy.allowed_origin_profile]) {
    issues.push({ path: 'policy.allowed_origin_profile', message: `unknown origin profile ${s.policy.allowed_origin_profile}` });
  }
  s.policy.environments.forEach((env, i) => {
    if (!policy.environments.includes(env)) issues.push({ path: `policy.environments.${i}`, message: `environment ${env} is not configured for project ${policy.project_id}` });
  });
  s.policy.mutations.forEach((m, i) => {
    const binding = policy.mutations[m];
    if (!binding) issues.push({ path: `policy.mutations.${i}`, message: `unknown mutation ${m}` });
    else for (const env of s.policy.environments) {
      if (!binding.environments.includes(env)) issues.push({ path: `policy.mutations.${i}`, message: `mutation ${m} is not permitted in environment ${env}` });
    }
  });

  s.inputs.forEach((ref, i) => checkRef(`inputs.${i}`, ref, true));
  if (s.mode === 'regression' && s.inputs.length > 0) issues.push({ path: 'inputs', message: 'inputs are only used by exploration scenarios' });
  if (new Set(s.requirement_ids).size !== s.requirement_ids.length) issues.push({ path: 'requirement_ids', message: 'duplicate requirement id' });
  const seen = new Set<string>();
  s.milestones.forEach((m, mi) => {
    const base = `milestones.${mi}`;
    if (seen.has(m.id)) issues.push({ path: `${base}.id`, message: `duplicate milestone id ${m.id}` });
    seen.add(m.id);
    if (s.mode === 'exploration' && m.steps.length > 0) {
      issues.push({ path: `${base}.steps`, message: 'exploration milestones are reached autonomously and must not script steps' });
    }
    m.steps.forEach((st, si) => {
      const p = `${base}.steps.${si}`;
      if (st.op === 'type') checkRef(`${p}.value_ref`, st.value_ref, true);
      if (st.op === 'select') checkRef(`${p}.option_ref`, st.option_ref, false);
      if (st.intent) {
        const bound = Object.entries(policy.mutations).filter(([, b]) => b.action_intents.includes(st.intent!));
        if (bound.length > 0 && !bound.some(([name]) => s.policy.mutations.includes(name))) {
          issues.push({ path: `${p}.intent`, message: `intent ${st.intent} is a mutation not authorized by this scenario's policy` });
        }
      }
    });
    m.assertions.forEach((a, ai) => {
      const p = `${base}.assertions.${ai}`;
      switch (a.type) {
        case 'ui_text':
          checkRef(`${p}.equals_ref`, a.equals_ref, false);
          break;
        case 'order_count_delta':
          checkRef(`${p}.customer_ref`, a.customer_ref, false);
          break;
        case 'order_total_minor_units':
          checkRef(`${p}.customer_ref`, a.customer_ref, false);
          checkRef(`${p}.equals_ref`, a.equals_ref, false);
          break;
        case 'entity_count_delta':
          checkRef(`${p}.owner_ref`, a.owner_ref, false);
          break;
        default:
          break;
      }
    });
  });
  return issues;
}

export async function loadValidatedScenario(path: string, catalog: FixtureCatalog, policy: ProjectPolicy): Promise<Scenario> {
  const s = await loadScenario(path);
  const issues = validateScenarioSemantics(s, catalog, policy);
  if (issues.length) throw new ContractError(path, issues);
  return s;
}
