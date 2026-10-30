import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

async function setup() {
  const { app } = makeApp();
  const mk = async (name: string) => (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name, kind: 'phone' } })).json().token as string;
  const joao = { authorization: `Bearer ${await mk('João')}` };
  const ana = { authorization: `Bearer ${await mk('Ana')}` };
  return { app, joao, ana };
}

describe('shared list API', () => {
  it('adds items, records who added them, and lists them', async () => {
    const { app, joao, ana } = await setup();
    const a = await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name: 'Leite', quantity: 6, unit: 'un' } });
    expect(a.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: ana, payload: { name: 'Pão', note: 'de forma' } });
    const list = (await app.inject({ url: '/api/v1/lists/current', headers: ana })).json();
    expect(list.items.map((i: { name: string; added_by: string }) => [i.name, i.added_by])).toEqual([['Leite', 'João'], ['Pão', 'Ana']]);
    expect(list.version).toBe(2);
  });

  it('is idempotent on client_id (offline queue resend)', async () => {
    const { app, joao } = await setup();
    const send = () => app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name: 'Ovos', client_id: 'c-1' } });
    expect((await send()).statusCode).toBe(201);
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/lists/current', headers: joao })).json().items).toHaveLength(1);
  });

  it('validates input with message keys', async () => {
    const { app, joao } = await setup();
    const bad = [{ name: '' }, { name: 'x', quantity: -1 }, { name: 'x', unit: 'lb' }, { name: 'x', state: 'bought' }];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message_key).toMatch(/^error\./);
    }
  });

  it('last write wins: older edits are ignored, newer applied, future clocks clamped', async () => {
    const { app, joao, ana } = await setup();
    const item = (await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name: 'Café' } })).json();
    const newer = await app.inject({ method: 'PATCH', url: `/api/v1/items/${item.id}`, headers: ana, payload: { quantity: 2, updated_at: new Date().toISOString() } });
    expect(newer.json()).toMatchObject({ applied: true, quantity: 2 });
    const older = await app.inject({ method: 'PATCH', url: `/api/v1/items/${item.id}`, headers: joao, payload: { quantity: 9, updated_at: '2020-01-01T00:00:00Z' } });
    expect(older.json()).toMatchObject({ applied: false, quantity: 2 });
    const future = await app.inject({ method: 'PATCH', url: `/api/v1/items/${item.id}`, headers: joao, payload: { quantity: 3, updated_at: '2999-01-01T00:00:00Z' } });
    expect(future.json().applied).toBe(true);
    expect(future.json().updated_at < '2999').toBe(true);
    const staleDelete = await app.inject({ method: 'DELETE', url: `/api/v1/items/${item.id}?updated_at=2020-01-01T00:00:00Z`, headers: ana });
    expect(staleDelete.statusCode).toBe(409);
  });

  it('delta sync returns changes since a version, including deletions', async () => {
    const { app, joao } = await setup();
    const add = (name: string) => app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name } });
    const a = (await add('A')).json();
    const v1 = (await app.inject({ url: '/api/v1/lists/current', headers: joao })).json().version;
    await add('B');
    await app.inject({ method: 'DELETE', url: `/api/v1/items/${a.id}`, headers: joao });
    const delta = (await app.inject({ url: `/api/v1/lists/current/changes?since=${v1}`, headers: joao })).json();
    expect(delta.items.map((i: { name: string; deleted: boolean }) => [i.name, i.deleted])).toEqual([['B', false], ['A', true]]);
    expect(delta.version).toBeGreaterThan(v1);
    expect((await app.inject({ url: '/api/v1/lists/current/changes?since=-1', headers: joao })).statusCode).toBe(400);
  });

  it('in-cart state, clearing in-cart items and clearing all', async () => {
    const { app, joao } = await setup();
    const ids: number[] = [];
    for (const name of ['A', 'B', 'C']) ids.push((await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name } })).json().id);
    await app.inject({ method: 'PATCH', url: `/api/v1/items/${ids[0]}`, headers: joao, payload: { state: 'in_cart' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/current/clear', headers: joao, payload: { scope: 'in_cart' } })).json().cleared).toBe(1);
    expect((await app.inject({ url: '/api/v1/lists/current', headers: joao })).json().items.map((i: { name: string }) => i.name)).toEqual(['B', 'C']);
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/current/clear', headers: joao, payload: { scope: 'all' } })).json().cleared).toBe(2);
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/current/clear', headers: joao, payload: { scope: 'x' } })).statusCode).toBe(400);
  });

  it('new list archives the old one into history, which can be repeated', async () => {
    const { app, joao, ana } = await setup();
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: joao, payload: { name: 'Arroz', quantity: 1, unit: 'kg' } });
    const old = (await app.inject({ url: '/api/v1/lists/current', headers: joao })).json().list.id;
    const fresh = (await app.inject({ method: 'POST', url: '/api/v1/lists', headers: joao })).json();
    expect(fresh.list.id).not.toBe(old);
    expect(fresh.items).toEqual([]);
    const history = (await app.inject({ url: '/api/v1/lists/history', headers: joao })).json().lists;
    expect(history).toMatchObject([{ id: old, item_count: 1 }]);
    const repeated = (await app.inject({ method: 'POST', url: `/api/v1/lists/history/${old}/repeat`, headers: ana })).json();
    expect(repeated.items).toMatchObject([{ name: 'Arroz', quantity: 1, unit: 'kg', state: 'pending', added_by: 'Ana' }]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/lists/history/999/repeat', headers: ana })).statusCode).toBe(404);
  });

  it('parse endpoint proposes items without saving them', async () => {
    const { app, joao } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/v1/lists/current/parse', headers: joao, payload: { text: '2 kg batata\nleite x6' } });
    expect(res.json().items).toMatchObject([{ name: 'Batata', quantity: 2, unit: 'kg' }, { name: 'Leite', quantity: 6, unit: 'un' }]);
    expect((await app.inject({ url: '/api/v1/lists/current', headers: joao })).json().items).toEqual([]);
  });

  it('requires a token for every list route', async () => {
    const { app } = await setup();
    for (const [method, url] of [['GET', '/api/v1/lists/current'], ['POST', '/api/v1/lists/current/items'], ['PATCH', '/api/v1/items/1'], ['POST', '/api/v1/lists']] as const)
      expect((await app.inject({ method, url })).statusCode).toBe(401);
  });
});
