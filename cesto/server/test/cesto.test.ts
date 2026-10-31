import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { enabledConnectors } from '../src/connectors/registry.js';
import { continenteConnector } from '../src/connectors/continente.js';
import type { CartApi } from '../src/basket.js';
import { normaliseAddress } from '../src/pairing.js';
import { asLan, testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';

const noCart = {} as CartApi;

async function setup(capabilities?: ('promotions' | 'purchase_history' | 'barcode_lookup')[]) {
  const db = openDatabase(':memory:');
  const { catalog } = fixtureCatalog({ frequent: ['4421406'] });
  const connector = { ...continenteConnector(catalog, noCart, () => true), ...(capabilities ? { capabilities } : {}) };
  const app = buildApp({ config: testConfig(), db, version: '1.0.0', connectors: [connector] });
  const admin = app;
  const token = (await admin.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  asLan(app);
  return { app, db, headers: { authorization: `Bearer ${token}` } };
}

describe('connectors', () => {
  it('reads enabled connectors from the options, ignoring unknown ids', () => {
    expect(enabledConnectors(['continente', 'continente', 'other'])).toEqual(['continente']);
    expect(enabledConnectors(undefined)).toEqual(['continente']);
    expect(enabledConnectors([])).toEqual(['continente']);
  });

  it('lists connectors with capabilities and simple mode for one supermarket', async () => {
    const { app, headers } = await setup();
    const res = (await app.inject({ url: '/api/v1/connectors', headers })).json();
    expect(res).toEqual({ connectors: [{ id: 'continente', name: 'Continente', capabilities: ['promotions', 'purchase_history', 'barcode_lookup'], session_valid: true }], default_store: 'continente', mode: 'simple' });
  });

  it('hides optional capabilities a connector does not declare', async () => {
    const { app, headers } = await setup([]);
    expect((await app.inject({ url: '/api/v1/habits', headers })).json().error.message_key).toBe('error.capability_unsupported');
    expect((await app.inject({ url: '/api/v1/promotions', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/catalog/search', headers, payload: { barcode: '5601312107545' } })).statusCode).toBe(404);
  });
});

describe('preferred supermarket per item', () => {
  it('validates the store, learns it from choices and filters proposals per store', async () => {
    const { app, headers } = await setup();
    const bad = await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'Leite', store: 'other' } });
    expect(bad.json().error.message_key).toBe('error.invalid_store');
    const a = (await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'Leite', store: 'continente' } })).json();
    expect(a.store).toBe('continente');
    await app.inject({ method: 'DELETE', url: `/api/v1/items/${a.id}`, headers });
    // Learned: the same item added again without a store keeps the last choice.
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'leite ' } })).json().store).toBe('continente');
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'Pão' } })).json().store).toBeNull();
    const p = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { store: 'continente' } });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ store: 'continente' });
    expect(p.json().lines).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { store: 'other' } })).statusCode).toBe(400);
  });
});

describe('pairing', () => {
  it('accepts only a bare http(s) origin', () => {
    expect(normaliseAddress('http://192.0.2.10:8099/')).toBe('http://192.0.2.10:8099');
    for (const bad of ['ftp://x', 'http://u:p@h', 'http://h/path', 'http://h?x=1', 'nope', 42]) expect(() => normaliseAddress(bad)).toThrow();
  });

  it('creates a device token with a QR code that works on the LAN and can be revoked', async () => {
    const db = openDatabase(':memory:');
    const app = buildApp({ config: testConfig(), db, version: '1.0.0' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/pair', payload: { name: 'Telemóvel', address: 'http://192.0.2.10:8099' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.uri).toBe(`cesto://pair?address=${encodeURIComponent('http://192.0.2.10:8099')}&token=${encodeURIComponent(body.token)}`);
    expect(body.qr_svg).toMatch(/^<svg/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/pair', payload: { name: 'x', address: 'http://h/p' } })).json().error.message_key).toBe('error.invalid_address');
    asLan(app);
    expect((await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } })).json()).toMatchObject({ name: 'Telemóvel', kind: 'phone' });
    // The pairing route is admin-only (ingress), never on the LAN port.
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/pair', payload: { name: 'x', address: 'http://h' } })).statusCode).toBe(403);
  });
});

describe('import (migration from the old add-on)', () => {
  const legacy = {
    format: 'continente-mcp-export', format_version: 1, app_version: '0.3.0', exported_at: '2026-10-31T00:00:00Z',
    lists: [{ id: 1, name: 'household', status: 'active', created_at: '2026-10-30T08:00:00Z', updated_at: '2026-10-30T08:00:00Z',
      items: [{ id: 1, client_id: 'c1', name: 'Manteiga', quantity: null, unit: null, note: 'Continente 2211084', category: null, added_by: 'A', state: 'pending', created_at: '2026-10-30T08:38:41Z', updated_at: '2026-10-30T08:38:41Z' },
        { id: 2, client_id: 'c2', name: 'Água', quantity: 6, unit: 'un', note: null, category: null, added_by: 'B', state: 'in_cart', created_at: '2026-10-30T09:00:00Z', updated_at: '2026-10-30T09:00:00Z' }] }],
    runs: [{ id: 1, list_id: 1, test_mode: 1, status: 'simulated', estimated_total_cents: 450, created_at: '2026-10-30T10:00:00Z', items: [{ item_name: 'Manteiga', product_id: '2211084', quantity: 1, outcome: 'simulated' }] }],
    preferences: [{ item_key: 'manteiga', product_id: '2211084', quantity: 1, chosen_by: 'A', updated_at: '2026-10-30T10:00:00Z' }],
  };

  it('imports a legacy export into an empty add-on once, keeping list, history and preferences', async () => {
    const db = openDatabase(':memory:');
    const app = buildApp({ config: testConfig(), db, version: '1.0.0' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/import', payload: legacy });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toEqual({ lists: 1, items: 2, runs: 1, preferences: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/import', payload: legacy })).statusCode).toBe(409);
    const exported = (await app.inject('/api/v1/admin/export')).json();
    expect(exported.lists[0].items.map((i: { name: string; state: string }) => [i.name, i.state])).toEqual([['Manteiga', 'pending'], ['Água', 'in_cart']]);
    expect(exported.runs[0].items[0].product_id).toBe('2211084');
    expect(exported.preferences).toHaveLength(1);
    // New writes continue after the imported change sequence.
    const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'P', kind: 'phone' } })).json().token;
    asLan(app);
    const headers = { authorization: `Bearer ${token}` };
    const before = (await app.inject({ url: '/api/v1/lists/current', headers })).json();
    expect(before.items).toHaveLength(2);
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'Pão' } });
    const delta = (await app.inject({ url: `/api/v1/lists/current/changes?since=${before.version}`, headers })).json();
    expect(delta.items.map((i: { name: string }) => i.name)).toEqual(['Pão']);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/import', payload: legacy })).statusCode).toBe(403);
  });

  it('rejects unknown formats', async () => {
    const app = buildApp({ config: testConfig(), db: openDatabase(':memory:'), version: '1.0.0' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/import', payload: { format: 'x' } })).json().error.message_key).toBe('error.import_format');
  });
});
