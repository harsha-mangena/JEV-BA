import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorizeAction, loadPolicy, ProjectPolicy, ScenarioPolicy, type ActionRequest, type AuthorizationContext } from '../src/index.ts';

const policy = await loadPolicy(join(import.meta.dirname, '../../../specs/policies/fixture-shop.yaml'));
const scenario = (mutations: string[] = [], extra: Partial<ScenarioPolicy> = {}): ScenarioPolicy =>
  ScenarioPolicy.parse({ environments: ['local'], mutations, external_effects: 'none', allowed_origin_profile: 'owned_checkout', ...extra });
const ctx = (over: Partial<AuthorizationContext> = {}): AuthorizationContext => ({ policy, scenario: scenario(['test_owned_order_create']), environment: 'local', role: 'customer', readOnly: false, ...over });

const place: ActionRequest = { op: 'CLICK', route: '/cart', control: { role: 'button', name: 'Place order', form: 'Checkout' }, declared_intent: 'checkout.submit' };
const code = (d: ReturnType<typeof authorizeAction>) => (d.allowed ? 'allowed' : d.code);

describe('authorizeAction', () => {
  it('allows a declared, scenario-authorized mutation and reports its effect', () => {
    expect(authorizeAction(ctx(), place)).toMatchObject({ allowed: true, effect: 'mutation', intent: 'checkout.submit', mutation: 'test_owned_order_create' });
  });

  it('denies every way of reaching a mutation without authority', () => {
    expect(code(authorizeAction(ctx(), { ...place, declared_intent: undefined }))).toBe('missing_intent');
    expect(code(authorizeAction(ctx(), { ...place, declared_intent: 'checkout.submt' }))).toBe('unknown_intent');
    expect(code(authorizeAction(ctx(), { ...place, declared_intent: 'notes.create' }))).toBe('conflicting_intent');
    expect(code(authorizeAction(ctx({ scenario: scenario([]) }), place))).toBe('mutation_not_authorized');
    expect(code(authorizeAction(ctx({ environment: 'production' }), place))).toBe('mutation_not_authorized');
    expect(code(authorizeAction(ctx({ readOnly: true }), place))).toBe('read_only_profile');
    // Autonomous drivers take the intent from the contract and may not declare one.
    expect(code(authorizeAction(ctx(), { ...place, declared_intent: undefined, intent_source: 'contract' }))).toBe('allowed');
    expect(code(authorizeAction(ctx(), { ...place, intent_source: 'contract' }))).toBe('conflicting_intent');
  });

  it('treats relabeled, out-of-scope and out-of-route controls as unknown effects', () => {
    expect(code(authorizeAction(ctx(), { ...place, control: { role: 'button', name: 'Continue', form: 'Checkout' } }))).toBe('unknown_effect');
    expect(code(authorizeAction(ctx(), { ...place, control: { role: 'button', name: 'Place order', form: 'Other' } }))).toBe('unknown_effect');
    expect(code(authorizeAction(ctx(), { ...place, route: '/notes' }))).toBe('unknown_effect');
    // The scenario opt-out that used to permit unknown effects no longer does.
    expect(code(authorizeAction(ctx({ scenario: scenario([], { unknown_actions: 'read_only_exploration' }) }), { op: 'CLICK', route: '/cart', control: { role: 'button', name: 'Mystery' } }))).toBe('unknown_effect');
  });

  it('resolves duplicate labels by form and denies an unscoped ambiguous binding', () => {
    const save = (form: string, intent: string): ActionRequest => ({ op: 'CLICK', route: '/settings', control: { role: 'button', name: 'Save', form }, declared_intent: intent });
    const c = ctx({ scenario: scenario(['test_owned_email_preferences_write']) });
    expect(authorizeAction(c, save('Email preferences', 'prefs.email_save'))).toMatchObject({ allowed: true, mutation: 'test_owned_email_preferences_write' });
    expect(code(authorizeAction(c, save('Profile', 'profile.save')))).toBe('mutation_not_authorized');
    expect(code(authorizeAction(c, save('Profile', 'prefs.email_save')))).toBe('conflicting_intent');
    const loose = ProjectPolicy.parse({ ...policy, control_bindings: policy.control_bindings.map((b) => (b.name === 'Save' ? { ...b, form: undefined } : b)) });
    expect(code(authorizeAction({ ...c, policy: loose }, save('Profile', 'prefs.email_save')))).toBe('ambiguous_binding');
  });

  it('checks typed parameters against what the control accepts', () => {
    const type = (ref?: string): ActionRequest => ({ op: 'TYPE', route: '/cart', control: { role: 'textbox', name: 'Delivery address', form: 'Checkout' }, parameter: ref ? { kind: 'ref', ref } : undefined });
    expect(code(authorizeAction(ctx(), type('fixture.delivery_address')))).toBe('allowed');
    expect(code(authorizeAction(ctx(), type('secret.password')))).toBe('parameter_not_accepted');
    expect(code(authorizeAction(ctx(), type()))).toBe('parameter_required');
    expect(code(authorizeAction(ctx(), { op: 'TYPE', route: '/cart', control: { role: 'textbox', name: 'Delivery address', form: 'Checkout' }, effect_only: true }))).toBe('allowed');
  });

  it('treats an autosaving field as the mutation it performs', () => {
    const nick: ActionRequest = { op: 'TYPE', route: '/settings', control: { role: 'textbox', name: 'Nickname', form: 'Profile' }, parameter: { kind: 'literal' } };
    expect(code(authorizeAction(ctx(), nick))).toBe('missing_intent');
    expect(code(authorizeAction(ctx(), { ...nick, declared_intent: 'profile.autosave' }))).toBe('mutation_not_authorized');
    expect(code(authorizeAction(ctx({ scenario: scenario(['test_owned_profile_write']) }), { ...nick, declared_intent: 'profile.autosave' }))).toBe('allowed');
  });

  it('authorizes keys by what they activate and navigation by registered routes', () => {
    expect(code(authorizeAction(ctx(), { op: 'PRESS', route: '/cart', key: 'Tab', control: null }))).toBe('allowed');
    expect(code(authorizeAction(ctx(), { op: 'PRESS', route: '/cart', key: 'Enter', control: null }))).toBe('no_focused_control');
    expect(code(authorizeAction(ctx(), { op: 'PRESS', route: '/cart', key: 'Enter', control: place.control }))).toBe('missing_intent');
    expect(code(authorizeAction(ctx(), { op: 'PRESS', route: '/cart', key: 'Enter', control: place.control, declared_intent: 'checkout.submit' }))).toBe('allowed');
    expect(code(authorizeAction(ctx(), { op: 'NAVIGATE', route: '/cart', path: '/orders/ord_1' }))).toBe('allowed');
    expect(code(authorizeAction(ctx(), { op: 'NAVIGATE', route: '/cart', path: '/admin' }))).toBe('unregistered_route');
    expect(code(authorizeAction(ctx({ readOnly: true }), { op: 'NAVIGATE', route: '/', path: '/login' }))).toBe('allowed');
  });

  it('refuses roles the binding does not admit', () => {
    const restricted = ProjectPolicy.parse({ ...policy, control_bindings: policy.control_bindings.map((b) => (b.name === 'Add note' ? { ...b, roles: ['customer'] } : b)) });
    const add: ActionRequest = { op: 'CLICK', route: '/notes', control: { role: 'button', name: 'Add note', form: 'New note' }, declared_intent: 'notes.create' };
    const c = ctx({ policy: restricted, scenario: scenario(['test_owned_note_write']) });
    expect(code(authorizeAction(c, add))).toBe('allowed');
    expect(code(authorizeAction({ ...c, role: 'viewer' }, add))).toBe('role_not_permitted');
  });
});
