import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkOnboarding, ONBOARDING_INPUTS } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '../../..');
const exists = (p: string) => access(join(ROOT, p)).then(() => true, () => false);

/** A structurally complete manifest (fixture-shop values, for the checker only; not a real target). */
const complete = () => ({
  schema_version: 1,
  application: { name: 'fixture-shop', owner_contact: 'qa-owner@example.test' },
  source: { repository: 'example/shop', provider: 'github', environment: 'preview', channel: 'per_channel' },
  candidate: { url_pattern: 'https://*.shop.example', revision_endpoint: { kind: 'meta', path: '/', name: 'app-revision' } },
  journeys: [{ id: 'checkout', roles: ['customer'], scenario_file: 'specs/scenarios/checkout_existing_customer.yaml', expectations_approved_by: 'product-owner' }],
  identities: { fixture_api_url: null, fixture_token_env: 'SHOP_FIXTURE_TOKEN', roles: [{ role: 'customer', fixture: 'customer_cart_one_item_v1' }] },
  mutations: [{ binding: 'checkout.submit', idempotency_key: 'Idempotency-Key header', effect_lookup: 'GET /__fixtures/effects?key=' }],
  backend_oracles: [{ id: 'order_count', verifies: 'an order row exists for the idempotency key', endpoint_env: 'SHOP_ORACLE_URL' }],
  cleanup: { rules: ['delete fixture-owned orders'], external_sandboxes: ['payments sandbox'] },
  profiles: { browsers: ['chromium'], viewports: ['1280x800', '390x844'], locales: ['en-US'], native_devices: [], visual_checkpoints: ['cart'] },
  artifacts: { retention_days: 30, model_sharing: 'sanitized_images' },
  promotion: { controller: 'release-bot', access_env: 'SHOP_PROMOTION_TOKEN', required_check: true },
});

describe('target onboarding manifest (completion Phase 4)', () => {
  it('the shipped template is BLOCKED and names every owner input and its use', async () => {
    const r = await checkOnboarding(parse(await readFile(join(ROOT, 'docs/templates/target-onboarding.yaml'), 'utf8')), exists);
    expect(r.status).toBe('BLOCKED');
    const missing = r.items.filter((i) => i.state === 'missing').map((i) => i.input);
    expect(missing).toEqual(['application.owner_contact', ...Object.keys(ONBOARDING_INPUTS)]);
    for (const i of r.items) expect(i.use).not.toBe('');
  });

  it('a complete manifest is READY', async () => {
    const r = await checkOnboarding(complete(), exists);
    expect(r.items.filter((i) => i.state !== 'provided')).toEqual([]);
    expect(r.status).toBe('READY');
  });

  it('one missing input keeps it BLOCKED; it is never filled with a default', async () => {
    const m = { ...complete(), backend_oracles: null };
    const r = await checkOnboarding(m, exists);
    expect(r.status).toBe('BLOCKED');
    expect(r.items.filter((i) => i.state === 'missing').map((i) => i.input)).toEqual(['backend_oracles']);
  });

  it('a malformed input or a missing scenario file is INVALID', async () => {
    expect((await checkOnboarding({ ...complete(), candidate: { url_pattern: 'shop.example', revision_endpoint: { kind: 'json', path: '/v', field: 'sha' } } }, exists)).status).toBe('INVALID');
    expect((await checkOnboarding({ ...complete(), identities: { ...complete().identities, fixture_token_env: 'lower-case' } }, exists)).status).toBe('INVALID');
    const r = await checkOnboarding({ ...complete(), journeys: [{ ...complete().journeys[0]!, scenario_file: 'specs/scenarios/nope.yaml' }] }, exists);
    expect(r).toMatchObject({ status: 'INVALID', items: expect.arrayContaining([expect.objectContaining({ input: 'journeys.checkout.scenario_file', state: 'invalid' })]) });
  });

  it('non-Chromium screenshot sharing is flagged: those engines withhold images', async () => {
    const m = complete();
    m.profiles.browsers = ['chromium', 'webkit'];
    const r = await checkOnboarding(m, exists);
    expect(r.items.find((i) => i.input === 'profiles.browsers')?.detail).toMatch(/withheld/);
  });
});
