import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from '../src/mcp/continente.js';
import { testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { FakeShop } from './fixtures/shop.js';

const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };

async function setup(testMode: boolean) {
  const db = openDatabase(':memory:');
  const shop = new FakeShop();
  const config = testConfig({ testMode });
  const mcp = new ContinenteMcp(new TestModeGuard(shop, () => config.testMode));
  const writer = new CartWriter(mcp, () => config.testMode);
  const { catalog } = fixtureCatalog({ frequent: ['4421406', '6600002'] });
  const app = buildApp({ config, db, version: '0.1.0', catalog, sessionEvents: mcp, cart: {
    getCart: () => mcp.getCart(), previewCartChanges: i => mcp.previewCartChanges(i),
    setQuantity: (id, q) => writer.setQuantity(id, q), clearCart: () => writer.clearCart() } });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  const add = (name: string, quantity?: number, unit?: string) => app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name, quantity, unit } });
  const propose = async () => (await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: {} })).json();
  const preview = (id: string, mode = 'merge') => app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/preview`, headers, payload: { mode } });
  const apply = (id: string, preview_id: string) => app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/apply`, headers, payload: { preview_id } });
  const job = async (id: string) => (await app.inject({ url: `/api/v1/jobs/${id}`, headers })).json();
  const finished = async (id: string) => { let j: { status: string } = { status: '' }; await until(async () => !['queued', 'running'].includes((j = await job(id)).status)); return j as Record<string, any>; };
  return { app, db, shop, mcp, headers, add, propose, preview, apply, finished };
}

describe('basket preview and apply', () => {
  it('merge: adds to what is already in the cart, verifies with get_cart, marks items and learns preferences', async () => {
    const t = await setup(false);
    t.shop.cart.set('4421406', 2);
    await t.add('leite', 6, 'un'); await t.add('arroz agulha', 1.5, 'kg');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    expect(pv.items.find((i: any) => i.product_id === '4421406')).toMatchObject({ current: 2, add: 6, desired: 8 });
    expect(pv.estimated_cost).toBeTruthy();
    expect(pv.problems).toEqual([]);
    const res = await t.apply(p.proposal_id, pv.preview_id);
    expect(res.statusCode).toBe(202);
    const j = await t.finished(res.json().job_id);
    expect(j.status).toBe('done');
    expect(t.shop.cart.get('4421406')).toBe(8);
    expect(t.shop.cart.get('6600002')).toBe(2);
    expect(j.lines.every((l: any) => l.in_cart)).toBe(true);
    const items = (await t.app.inject({ url: '/api/v1/lists/current', headers: t.headers })).json().items;
    expect(items.every((i: any) => i.state === 'in_cart')).toBe(true);
    expect((await t.app.inject({ url: '/api/v1/preferences', headers: t.headers })).json().preferences).toHaveLength(2);
    expect(t.db.prepare('SELECT status, test_mode FROM history_runs').get()).toMatchObject({ status: 'done', test_mode: 0 });
    expect(t.shop.mutations().every(c => c.name === 'set_cart_item_quantity')).toBe(true);
  });

  it('replace: clears the cart first and reports what will be removed', async () => {
    const t = await setup(false);
    t.shop.cart.set('9999999', 1); t.shop.cart.set('4421406', 3);
    await t.add('leite', 2, 'un');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id, 'replace')).json();
    expect(pv.removed).toEqual([{ productId: '9999999', quantity: 1 }]);
    expect(pv.items[0].desired).toBe(2);
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j.status).toBe('done');
    expect([...t.shop.cart]).toEqual([['4421406', 2]]);
    expect(t.shop.mutations()[0]!.name).toBe('clear_cart');
  });

  it('test mode never touches the real cart and leaves the list untouched', async () => {
    const t = await setup(true);
    t.shop.cart.set('4421406', 1);
    await t.add('leite', 2, 'un');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id, 'replace')).json();
    expect(pv.test_mode).toBe(true);
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j).toMatchObject({ status: 'simulated', test_mode: true, message_key: null });
    expect(t.shop.mutations()).toHaveLength(0);
    expect([...t.shop.cart]).toEqual([['4421406', 1]]);
    const items = (await t.app.inject({ url: '/api/v1/lists/current', headers: t.headers })).json().items;
    expect(items[0].state).toBe('pending');
  });

  it('unknown outcome stops the job, reads the cart and never replays', async () => {
    const t = await setup(false);
    t.shop.unknownFor.add('4421406');
    await t.add('leite', 2, 'un'); await t.add('arroz agulha', 1, 'kg');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j).toMatchObject({ status: 'needs_attention', message_key: 'basket.unknown_outcome' });
    expect(t.shop.mutations().filter(c => c.args.productId === '4421406')).toHaveLength(1);
    expect(t.shop.calls.at(-1)!.name).toBe('get_cart');
    expect(j.cart_after).toBeTruthy();
  });

  it('not_applied and silently dropped lines are reported after verification', async () => {
    const t = await setup(false);
    t.shop.notAppliedFor.add('4421406'); t.shop.dropFor.add('6600002');
    await t.add('leite', 2, 'un'); await t.add('arroz agulha', 1, 'kg');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j.status).toBe('needs_attention');
    expect(j.lines.map((l: any) => [l.outcome, l.in_cart])).toEqual([['not_applied', false], ['confirmed', false]]);
  });

  it('a stale preview is rejected; pending choices block the preview', async () => {
    const t = await setup(false);
    await t.add('leite', 2, 'un'); await t.add('iogurtes');
    const p = await t.propose();
    expect((await t.preview(p.proposal_id)).statusCode).toBe(409);
    const yog = p.lines.find((l: any) => l.item_name === 'iogurtes');
    await t.app.inject({ method: 'PATCH', url: `/api/v1/basket/proposals/${p.proposal_id}/lines/${yog.item_id}`, headers: t.headers, payload: { skip: true } });
    const pv = (await t.preview(p.proposal_id)).json();
    await t.app.inject({ method: 'PATCH', url: `/api/v1/basket/proposals/${p.proposal_id}/lines/${yog.item_id}`, headers: t.headers, payload: { skip: false, product_id: '3300001' } });
    expect((await t.apply(p.proposal_id, pv.preview_id)).statusCode).toBe(409);
    expect((await t.apply(p.proposal_id, 'bogus')).statusCode).toBe(409);
    expect(t.shop.mutations()).toHaveLength(0);
  });

  it('an expired session parks the job and resumes it when the session is back', async () => {
    const t = await setup(false);
    await t.add('leite', 2, 'un');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    t.shop.expired = true;
    const id = (await t.apply(p.proposal_id, pv.preview_id)).json().job_id;
    expect((await t.finished(id)).status).toBe('waiting_session');
    t.shop.expired = false;
    await t.mcp.getCart(); // session check flips sessionValid -> true
    const j = await t.finished(id);
    expect(j.status).toBe('done');
    expect(t.shop.cart.get('4421406')).toBe(2);
  });
});

describe('previewProblems', () => {
  it('turns continentept-mcp 0.12 preview data (problems is a count) into a list', async () => {
    const { previewProblems } = await import('../src/basket.js');
    const data = {
      lines: [
        { productId: '1', name: 'Leite', availability: 'available', error: null },
        { productId: '2', name: 'Manteiga', availability: 'unavailable', error: null },
        { productId: '3', name: null, availability: null, error: { code: 'quantity_below_minimum', message: 'x', retryable: false } },
      ],
      estimatedCost: null, estimated: false, problems: 2,
    };
    expect(previewProblems(data)).toEqual([
      { product_id: '2', name: 'Manteiga', availability: 'unavailable', error_key: null },
      { product_id: '3', name: null, availability: null, error_key: 'error.quantity_below_minimum' },
    ]);
    expect(previewProblems(undefined)).toEqual([]);
  });
});
