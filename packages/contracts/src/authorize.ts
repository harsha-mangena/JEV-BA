import type { RiskClass } from './decision.ts';
import type { ContractOperation, ControlBindingSpec, ProjectPolicy } from './policy.ts';
import type { ScenarioPolicy } from './scenario.ts';

/** Effect of an action as established by the trusted application contract. */
export type Effect = 'none' | 'session' | 'mutation' | 'external' | 'unknown';

export interface ControlIdentity {
  role: string;
  name: string;
  form?: string | undefined;
  section?: string | undefined;
}

export type ActionRequest =
  | {
      op: 'CLICK' | 'TYPE' | 'SELECT';
      route: string;
      control: ControlIdentity;
      declared_intent?: string | undefined;
      parameter?: ParameterUse | undefined;
      /**
       * `declared` (approved steps): a mutating control must carry its intent.
       * `contract` (autonomous drivers): the controller takes the intent from the
       * trusted contract; the model never declares one. Authorization still applies.
       */
      intent_source?: 'declared' | 'contract';
      /** Check the effect only (gate stage 2); the parameter is checked in a second call. */
      effect_only?: boolean;
    }
  | { op: 'PRESS'; route: string; key: string; control: ControlIdentity | null; declared_intent?: string | undefined }
  | { op: 'NAVIGATE'; route: string; path: string; declared_intent?: string | undefined }
  | { op: 'RELOAD'; route: string; declared_intent?: string | undefined }
  | { op: 'SCROLL' | 'WAIT' | 'DONE' | 'BLOCKED'; route: string };

/** A typed parameter: a fixture/secret reference or a scenario literal. Values never reach this service. */
export type ParameterUse = { kind: 'ref'; ref: string } | { kind: 'literal' };

export interface AuthorizationContext {
  policy: ProjectPolicy;
  scenario: ScenarioPolicy;
  environment: string;
  /** Fixture role the session acts as. */
  role: string;
  /** Read-only capability profile: only effect-free actions on proven read-only controls/routes. */
  readOnly: boolean;
}

export type AuthorizationCode =
  | 'unknown_intent'
  | 'unknown_effect'
  | 'ambiguous_binding'
  | 'operation_not_bound'
  | 'missing_intent'
  | 'conflicting_intent'
  | 'mutation_not_authorized'
  | 'external_effect_not_permitted'
  | 'read_only_profile'
  | 'role_not_permitted'
  | 'parameter_not_accepted'
  | 'parameter_required'
  | 'unregistered_route'
  | 'no_focused_control';

export type AuthorizationDecision =
  | { allowed: true; effect: Effect; intent: string | null; mutation: string | null; risk_class: RiskClass; binding: string | null }
  | { allowed: false; code: AuthorizationCode; reason: string; effect: Effect; intent: string | null };

const NAV_KEYS = new Set(['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'ArrowUp']);

function routeRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
}

export const routeMatches = (path: string, pattern: string) => routeRegex(pattern).test(path);

function nameMatches(b: ControlBindingSpec, name: string): boolean {
  return b.name !== undefined ? b.name === name : new RegExp(`^(?:${b.name_pattern})$`).test(name);
}

function defaultOperations(role: string): ContractOperation[] {
  if (role === 'textbox' || role === 'searchbox') return ['TYPE'];
  if (role === 'combobox' || role === 'listbox') return ['SELECT'];
  return ['CLICK', 'PRESS'];
}

/**
 * Resolve the trusted binding for a control at a route. Bindings scoped to a
 * form/section only match controls in that scope; when several bindings match
 * and disagree about the effect, the result is ambiguous and denied.
 */
export function resolveBinding(policy: ProjectPolicy, route: string, c: ControlIdentity): { binding: ControlBindingSpec; index: number } | { ambiguous: ControlBindingSpec[] } | null {
  const hits = policy.control_bindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding: b }) => {
      if (b.role !== c.role || !nameMatches(b, c.name)) return false;
      if (b.route && ![b.route].flat().some((r) => routeMatches(route, r))) return false;
      if (b.form !== undefined && b.form !== c.form) return false;
      if (b.section !== undefined && b.section !== c.section) return false;
      if (b.section_pattern !== undefined && !new RegExp(`^(?:${b.section_pattern})$`).test(c.section ?? '')) return false;
      return true;
    });
  if (hits.length === 0) return null;
  const effects = new Set(hits.map((h) => `${h.binding.intent ?? ''}|${h.binding.risk_class}`));
  if (effects.size > 1) return { ambiguous: hits.map((h) => h.binding) };
  return hits[0]!;
}

function effectOf(policy: ProjectPolicy, b: ControlBindingSpec): Effect {
  if (b.intent) {
    const kind = policy.intents[b.intent]?.kind;
    if (kind === 'mutation') return 'mutation';
    if (kind === 'session') return 'session';
    if (kind === 'external') return 'external';
  }
  switch (b.risk_class) {
    case 'test_owned_mutation':
      return 'mutation';
    case 'external_effect':
      return 'external';
    case 'read_only':
    case 'reversible_input':
      return 'none';
    default:
      return 'unknown';
  }
}

const deny = (code: AuthorizationCode, reason: string, effect: Effect = 'unknown', intent: string | null = null): AuthorizationDecision => ({ allowed: false, code, reason, effect, intent });

function authorizeMutation(ctx: AuthorizationContext, intent: string): AuthorizationDecision | { mutation: string } {
  const bound = Object.entries(ctx.policy.mutations).filter(([, m]) => m.action_intents.includes(intent));
  for (const [name, m] of bound) {
    if (ctx.scenario.mutations.includes(name) && m.environments.includes(ctx.environment)) return { mutation: name };
  }
  return deny('mutation_not_authorized', `intent ${intent} needs one of [${bound.map(([n]) => n).join(', ') || 'no mutation binding'}] authorized by the scenario for environment ${ctx.environment}`, 'mutation', intent);
}

/**
 * The single authorization path for every driver (regression, exploration,
 * S2-selected and compiled execution). Permission comes only from the trusted
 * application contract plus project, scenario and environment policy; missing
 * annotations never imply permission, and unknown effects are denied.
 */
export function authorizeAction(ctx: AuthorizationContext, a: ActionRequest): AuthorizationDecision {
  const declared = 'declared_intent' in a ? a.declared_intent : undefined;
  if (declared && !ctx.policy.intents[declared]) return deny('unknown_intent', `intent ${declared} is not in the application contract`, 'unknown', declared);

  if (a.op === 'SCROLL' || a.op === 'WAIT' || a.op === 'DONE' || a.op === 'BLOCKED') {
    return { allowed: true, effect: 'none', intent: null, mutation: null, risk_class: 'read_only', binding: null };
  }
  if (a.op === 'NAVIGATE' || a.op === 'RELOAD') {
    const path = a.op === 'NAVIGATE' ? a.path.split('?')[0]! : a.route;
    const r = ctx.policy.routes.find((x) => routeMatches(path, x.path));
    if (!r) return deny('unregistered_route', `navigation to ${path} is not a registered route of the application contract`);
    if (declared) return deny('conflicting_intent', `navigation cannot carry intent ${declared}`, r.effect, declared);
    if (ctx.readOnly && r.effect !== 'none') return deny('read_only_profile', `route ${r.path} has effect ${r.effect}`, r.effect);
    return { allowed: true, effect: r.effect, intent: null, mutation: null, risk_class: 'read_only', binding: `route:${r.path}` };
  }

  const el = a as Extract<ActionRequest, { control: unknown }>;
  let op: ContractOperation = el.op;
  let control: ControlIdentity | null = el.control;
  if (el.op === 'PRESS') {
    if (NAV_KEYS.has(el.key)) {
      if (declared) return deny('conflicting_intent', `focus navigation cannot carry intent ${declared}`, 'none', declared);
      return { allowed: true, effect: 'none', intent: null, mutation: null, risk_class: 'read_only', binding: `key:${el.key}` };
    }
    // Enter/Space activate the focused control: authorize the control's own effect.
    if (!control) return deny('no_focused_control', `${el.key} with no focused control has unknown effect`);
    op = 'PRESS';
  }
  control = control!;

  const resolved = resolveBinding(ctx.policy, el.route, control);
  if (!resolved) return deny('unknown_effect', `no trusted binding for ${control.role} "${control.name}"${control.form ? ` in form "${control.form}"` : ''} on ${el.route}`, 'unknown', declared ?? null);
  if ('ambiguous' in resolved) return deny('ambiguous_binding', `${control.role} "${control.name}" matches bindings with different effects; add form/section scope`, 'unknown', declared ?? null);
  const b = resolved.binding;
  const ops = b.operations ?? defaultOperations(b.role);
  if (!ops.includes(op)) return deny('operation_not_bound', `${op} is not a bound operation for ${control.role} "${control.name}"`, 'unknown', declared ?? null);
  if (b.roles && !b.roles.includes(ctx.role)) return deny('role_not_permitted', `role ${ctx.role} may not use ${control.role} "${control.name}"`, effectOf(ctx.policy, b), b.intent ?? null);

  const effect = effectOf(ctx.policy, b);
  const fromContract = el.op !== 'PRESS' && el.intent_source === 'contract';
  if (fromContract && declared) return deny('conflicting_intent', 'autonomous actions cannot declare their own intent', effect, declared);
  if (effect === 'unknown') return deny('unknown_effect', `binding for ${control.role} "${control.name}" has unknown effect`, 'unknown', b.intent ?? null);
  if (effect === 'mutation' && !declared && !fromContract) return deny('missing_intent', `${control.role} "${control.name}" performs ${b.intent}; the step must declare that intent`, effect, b.intent ?? null);
  if (!fromContract && declared && declared !== b.intent) return deny('conflicting_intent', `declared intent ${declared} contradicts the contract (${b.intent ?? 'no intent'})`, effect, declared);
  if (ctx.readOnly && effect !== 'none') return deny('read_only_profile', `read-only profile refuses ${effect} effect of ${control.role} "${control.name}"`, effect, b.intent ?? null);

  let mutation: string | null = null;
  if (effect === 'mutation') {
    const m = authorizeMutation(ctx, b.intent!);
    if ('allowed' in m) return m;
    mutation = m.mutation;
  } else if (effect === 'external' && ctx.scenario.external_effects !== 'sandbox_only') {
    return deny('external_effect_not_permitted', `${control.role} "${control.name}" has an external effect and the scenario permits none`, effect, b.intent ?? null);
  }

  if ((el.op === 'TYPE' || el.op === 'SELECT') && !el.effect_only) {
    if (!el.parameter) return deny('parameter_required', `${el.op} needs a typed parameter`, effect, b.intent ?? null);
    if (!b.accepts) return deny('parameter_not_accepted', `binding for ${control.role} "${control.name}" declares no accepted parameters`, effect, b.intent ?? null);
    const key = el.parameter.kind === 'literal' ? 'literal' : el.parameter.ref;
    if (!b.accepts.includes(key)) return deny('parameter_not_accepted', `${key} is not accepted by ${control.role} "${control.name}" (accepts ${b.accepts.join(', ')})`, effect, b.intent ?? null);
  }
  const risk: RiskClass = effect === 'mutation' ? 'test_owned_mutation' : effect === 'external' ? 'external_effect' : el.op === 'TYPE' || el.op === 'SELECT' ? 'reversible_input' : 'read_only';
  return { allowed: true, effect, intent: b.intent ?? null, mutation, risk_class: risk, binding: `binding:${resolved.index}` };
}
