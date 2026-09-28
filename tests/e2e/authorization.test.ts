import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '@qa/browser';
import type { ProvisionedFixture, Scenario } from '@qa/contracts';
import type { DefectId, FixtureApp } from '@qa/fixture-test-app';
import { FixtureClient } from '@qa/oracles';
import { KeywordProvider, type ChoiceQuestion, type S1Request, type SystemOneProvider } from '@qa/s1';
import type { SystemTwoProvider } from '@qa/s2';
import { runSuite, type ExplorationOptions } from '@qa/worker';
import { outDir, policy, scenario, TOKEN } from './helpers.ts';
import { startFixtureApp } from '@qa/fixture-test-app';

/**
 * Effect authorization (audit F02, completion phase 1). Every denial is
 * checked against the application's own write journal and the application
 * adapter's entity oracle — never only against a log line saying DENY.
 */

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/** Adapter that snapshots the fixture user's profile through the entity oracle before cleanup removes it. */
class ProfileWitness extends FixtureClient {
  owner: string | null = null;
  profiles: Array<Record<string, unknown>> = [];
  override async provision(name: string, signal?: AbortSignal): Promise<ProvisionedFixture> {
    const f = await super.provision(name, signal);
    this.owner = String(f.data.customer_id);
    return f;
  }
  override async cleanup(fixtureId: string, signal?: AbortSignal): Promise<number> {
    if (this.owner) this.profiles.push(...(await this.entities('profile', this.owner, signal)));
    return super.cleanup(fixtureId, signal);
  }
}

async function run(s: Scenario, defects: DefectId[] = [], exploration?: ExplorationOptions) {
  const a: FixtureApp = await startFixtureApp({ fixtureToken: TOKEN, defects });
  const fixtures = new ProfileWitness(a.url, TOKEN);
  try {
    const { report } = await runSuite({ scenarios: [s], policy, baseUrl: a.url, environment: 'local', fixtures, outDir: await outDir(), browser, profiles: ['chromium_desktop'], signedOutPath: '/login', ...(exploration ? { exploration } : {}) });
    const writes = (path: string) => a.store.writes.filter((w) => w.path === path).length;
    return { c: report.cases[0]!, writes, fixtures, app: a };
  } finally {
    await a.close();
  }
}

async function checkout(patch: (s: Scenario) => void): Promise<Scenario> {
  const s = structuredClone(await scenario('checkout_existing_customer'));
  s.execution_profiles = ['chromium_desktop'];
  patch(s);
  return s;
}

const placeStep = (s: Scenario) => s.milestones[1]!.steps[1] as Extract<Scenario['milestones'][number]['steps'][number], { op: 'click' }>;

async function settings(steps: Scenario['milestones'][number]['steps'], mutations: string[], assertions: Scenario['milestones'][number]['assertions'] = [{ type: 'ui_visible', target: { testid: 'settings-saved' } }]): Promise<Scenario> {
  const s = structuredClone(await scenario('settings_preference_persists'));
  s.id = 'settings_authorization_probe';
  s.policy.mutations = mutations;
  s.milestones = [{ id: 'act', steps, assertions }];
  return s;
}

describe.concurrent('approved steps: effects come from the trusted contract', () => {
  it('positive control: a declared, authorized checkout submits exactly once', async () => {
    const { c, writes } = await run(await checkout(() => undefined));
    expect(c.verdict, c.message ?? '').toBe('PASS');
    expect(writes('/checkout')).toBe(1);
  });

  it('a known mutating control without its intent is denied before any input (missing_intent)', async () => {
    const { c, writes } = await run(await checkout((s) => {
      delete placeStep(s).intent;
      delete s.milestones[1]!.action_intent;
    }));
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/must declare that intent/);
    expect(writes('/checkout')).toBe(0);
  });

  it('a misspelled intent is not in the contract and is denied (unknown_intent)', async () => {
    const { c, writes } = await run(await checkout((s) => {
      placeStep(s).intent = 'checkout.submt';
    }));
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/checkout\.submt is not in the application contract/);
    expect(writes('/checkout')).toBe(0);
  });

  it('a mutating control relabeled "Continue" is an unknown effect even when addressed by its test id', async () => {
    const { c, writes } = await run(await checkout((s) => {
      placeStep(s).target = { testid: 'place-order' };
    }), ['ambiguous_checkout_labels']);
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/no trusted binding for button "Continue" in form "Checkout"/);
    expect(writes('/checkout')).toBe(0);
    expect(writes('/cart/save')).toBe(0);
  });

  it('a parameter the control does not accept is refused (a password typed into the address field)', async () => {
    const { c, writes } = await run(await checkout((s) => {
      const t = s.milestones[1]!.steps[0] as { value_ref?: string };
      t.value_ref = 'secret.password';
    }));
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/secret\.password is not accepted by textbox "Delivery address"/);
    expect(writes('/checkout')).toBe(0);
  });

  it('duplicate "Save" labels resolve by form: the wrong intent conflicts, an unauthorized form is refused', async () => {
    const conflicting = await run(await settings([{ op: 'click', target: { testid: 'profile-save' }, intent: 'prefs.email_save' }], ['test_owned_email_preferences_write']));
    expect(conflicting.c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(conflicting.c.message).toMatch(/contradicts the contract \(profile\.save\)/);
    expect(conflicting.writes('/settings/profile')).toBe(0);
    expect(conflicting.writes('/settings/email')).toBe(0);

    const unauthorized = await run(await settings([{ op: 'click', target: { testid: 'profile-save' }, intent: 'profile.save' }], ['test_owned_email_preferences_write']));
    expect(unauthorized.c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(unauthorized.c.message).toMatch(/test_owned_profile_write/);
    expect(unauthorized.writes('/settings/profile')).toBe(0);

    // Positive control: the same label in the authorized form performs exactly its own effect.
    const ok = await run(
      await settings(
        [
          { op: 'click', target: { role: 'checkbox', name: 'Send me offers' } },
          { op: 'click', target: { testid: 'email-save' }, intent: 'prefs.email_save' },
        ],
        ['test_owned_email_preferences_write'],
        [{ type: 'ui_text', target: { testid: 'current-offers' }, equals: 'on' }],
      ),
    );
    expect(ok.c.verdict, ok.c.message ?? '').toBe('PASS');
    expect(ok.writes('/settings/email')).toBe(1);
    expect(ok.writes('/settings/profile')).toBe(0);
    expect(ok.fixtures.profiles).toEqual([expect.objectContaining({ email_offers: true, nickname: '' })]);
  });

  it('typing into an autosaving field is a mutation: undeclared or unauthorized autosave never reaches the backend', async () => {
    const undeclared = await run(await settings([{ op: 'type', target: { label: 'Nickname' }, value: 'rogue' }], []));
    expect(undeclared.c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(undeclared.c.message).toMatch(/performs profile\.autosave/);
    expect(undeclared.writes('/settings/profile/autosave')).toBe(0);
    expect(undeclared.fixtures.profiles).toEqual([expect.objectContaining({ nickname: '' })]);

    const unauthorized = await run(await settings([{ op: 'type', target: { label: 'Nickname' }, value: 'rogue', intent: 'profile.autosave' }], ['test_owned_email_preferences_write']));
    expect(unauthorized.c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(unauthorized.writes('/settings/profile/autosave')).toBe(0);
    expect(unauthorized.fixtures.profiles).toEqual([expect.objectContaining({ nickname: '' })]);
  });

  it('navigation outside the registered routes is denied', async () => {
    const { c, writes } = await run(await settings([{ op: 'navigate', path: '/admin' }], []));
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/not a registered route/);
    expect(writes('/settings')).toBe(0);
  });
});

/** Offline S1 for the checkout goal (reads only the request, never the DOM). */
function splitCheckoutModel(): SystemOneProvider {
  const base = new KeywordProvider((req: S1Request, q: ChoiceQuestion) => {
    const route = (JSON.parse(req.context) as { route: string }).route;
    const typeHead = req.questions.find((x) => x.id === 'type_target') as ChoiceQuestion | undefined;
    const addressFilled = typeHead?.options.some((o) => o.label.includes('Delivery address') && o.label.includes('value "1 Test'));
    if (q.id === 'op') return route.startsWith('/orders/') ? ['DONE'] : addressFilled || !typeHead ? ['CLICK'] : ['TYPE'];
    if (q.id === 'click_target') return ['"Save cart for later"'];
    if (q.id === 'type_target') return ['"Delivery address"'];
    if (q.id === 'type_value') return ['fixture.delivery_address'];
    return [];
  });
  return {
    id: 'split',
    async ask(req) {
      const r = await base.ask(req);
      const click = req.questions.find((q) => q.id === 'click_target') as ChoiceQuestion | undefined;
      if (click) {
        const place = click.options.find((o) => o.label.includes('"Place order"'))?.key;
        const save = click.options.find((o) => o.label.includes('"Save cart for later"'))?.key;
        if (place && save) r.answers.click_target = { probabilities: Object.fromEntries(click.options.map((o) => [o.key, o.key === save ? 0.48 : o.key === place ? 0.44 : 0.08 / (click.options.length - 2)])) };
      }
      return r;
    },
  };
}

describe('autonomous selection passes the same authorization', () => {
  it('an S2-selected mutating target the scenario does not authorize is never clicked', async () => {
    const picked: string[] = [];
    const s2: SystemTwoProvider = {
      id: 's2-forbidden',
      supportsImages: false,
      async propose(input) {
        const place = input.observation.candidates.find((c) => c.name === 'Place order')!;
        picked.push(place.node_id);
        return { kind: 'SELECT_OBSERVED_TARGET', node_id: place.node_id, evidence_refs: ['section:Checkout'], reason: 'submit the order' };
      },
    };
    const s = structuredClone(await scenario('checkout_exploration', 'exploration'));
    s.policy.mutations = [];
    const { c, writes } = await run(s, [], { s1: splitCheckoutModel(), s2, model: 'm' });
    expect(picked).toHaveLength(1);
    expect(c).toMatchObject({ verdict: 'BLOCKED', reason: 'policy_denied' });
    expect(c.message).toMatch(/mutation_not_authorized/);
    expect(writes('/checkout')).toBe(0);
  });
});
