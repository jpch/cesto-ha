import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';

async function setup(withCatalog = true) {
  const db = openDatabase(':memory:');
  const { catalog } = fixtureCatalog({ frequent: ['4421406'] });
  const app = buildApp({ config: testConfig(), db, version: '0.1.0', catalog: withCatalog ? catalog : undefined });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  return { app, headers };
}

describe('basket proposals API', () => {
  it('matches pending items, lets the user choose, and stores shared preferences', async () => {
    const { app, headers } = await setup();
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'leite', quantity: 2, unit: 'un' } });
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'iogurtes' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: {} });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.lines).toHaveLength(2);
    const yog = p.lines.find((l: { item_name: string }) => l.item_name === 'iogurtes');
    expect(yog.needs_choice).toBe(true);
    const chosen = await app.inject({ method: 'PATCH', url: `/api/v1/basket/proposals/${p.proposal_id}/lines/${yog.item_id}`, headers, payload: { product_id: yog.options[0].product_id, quantity: 2 } });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json().lines.find((l: { item_id: number }) => l.item_id === yog.item_id)).toMatchObject({ needs_choice: false, quantity: 2 });
    expect((await app.inject({ url: `/api/v1/basket/proposals/${p.proposal_id}`, headers })).json().updated_at).toBeTruthy();
    expect((await app.inject({ url: '/api/v1/basket/proposals/nope', headers })).statusCode).toBe(404);

    expect((await app.inject({ method: 'PUT', url: '/api/v1/preferences/Iogurtes', headers, payload: { product_id: '3300002' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/preferences', headers })).json().preferences).toHaveLength(1);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/preferences/x', headers, payload: { product_id: 'abc' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/preferences/iogurtes', headers })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/habits', headers })).statusCode).toBe(200);
  });

  it('409 with nothing pending, 503 without the MCP, 401 without token', async () => {
    const { app, headers } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: {} })).statusCode).toBe(409);
    const off = await setup(false);
    expect((await off.app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers: off.headers, payload: {} })).statusCode).toBe(503);
    expect((await app.inject({ url: '/api/v1/preferences' })).statusCode).toBe(401);
  });
});
