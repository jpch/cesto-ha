import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { cartQuantityOf, quantityInCart } from '../src/basket.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from '../src/mcp/continente.js';
import { asLan, testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { FakeShop } from './fixtures/shop.js';

const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };

async function setup(testMode: boolean) {
  const db = openDatabase(':memory:');
  const shop = new FakeShop();
  const config = testConfig({ testMode });
  const mcp = new ContinenteMcp(new TestModeGuard(shop, () => config.testMode));
  const writer = new CartWriter(mcp, () => config.testMode);
  const { catalog, calls } = fixtureCatalog({ frequent: ['4421406', '6600002'] });
  const app = buildApp({ config, db, version: '0.1.0', catalog, sessionEvents: mcp, verifyDelaysMs: [0, 0, 0], cart: {
    getCart: () => mcp.getCart(), previewCartChanges: i => mcp.previewCartChanges(i),
    setQuantity: (id, q) => writer.setQuantity(id, q), clearCart: () => writer.clearCart() } });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  asLan(app);
  const add = (name: string, quantity?: number, unit?: string) => app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name, quantity, unit } });
  const propose = async () => (await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: {} })).json();
  const preview = (id: string, mode = 'merge') => app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/preview`, headers, payload: { mode } });
  const apply = (id: string, preview_id: string) => app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/apply`, headers, payload: { preview_id } });
  const job = async (id: string) => (await app.inject({ url: `/api/v1/jobs/${id}`, headers })).json();
  const finished = async (id: string) => { let j: { status: string } = { status: '' }; await until(async () => !['queued', 'running'].includes((j = await job(id)).status)); return j as Record<string, any>; };
  return { app, db, shop, mcp, headers, add, propose, preview, apply, finished, calls, job };
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
    expect(previewProblems({ status: 'success', data })).toEqual([
      { product_id: '2', name: 'Manteiga', availability: 'unavailable', error_key: null },
      { product_id: '3', name: null, availability: null, error_key: 'error.quantity_below_minimum' },
    ]);
    expect(previewProblems(undefined)).toEqual([]);
  });
});

describe('cart read-back (0.3.0, decisions 54-55)', () => {
  it('reads continentept-mcp 0.12 cart quantities ({status, quantity:{value}}) instead of NaN', () => {
    expect(cartQuantityOf({ status: 'known', quantity: { value: 6, unit: 'un' } })).toBe(6);
    expect(cartQuantityOf({ status: 'unknown', value: 2, rawText: '2', reason: 'unrecognized_format' })).toBe(2);
    expect(cartQuantityOf({ status: 'unknown', value: null, rawText: null, reason: 'missing' })).toBeNull();
    expect(cartQuantityOf(3)).toBe(3);
    expect(cartQuantityOf('1.5')).toBe(1.5);
    expect(quantityInCart([{ productId: '1', quantity: 2 }, { productId: '1', quantity: 1 }], '1')).toBe(3);
    expect(quantityInCart([{ productId: '1', quantity: null }], '1')).toBeNull();
    expect(quantityInCart([], '1')).toBe(0);
  });

  it('five items all in the cart: done, nothing missing (regression for the false "needs attention")', async () => {
    const t = await setup(false);
    await t.add('leite', 6, 'un'); await t.add('arroz agulha', 1, 'kg'); await t.add('ovos', 1, 'un'); await t.add('iogurte natural', 4, 'un'); await t.add('arroz carolino', 1, 'un');
    const p = await t.propose();
    for (const l of p.lines.filter((l: any) => l.needs_choice)) await t.app.inject({ method: 'PATCH', url: `/api/v1/basket/proposals/${p.proposal_id}/lines/${l.item_id}`, headers: t.headers, payload: { product_id: l.options[0].product_id } });
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j.status).toBe('done');
    expect(j.missing).toEqual([]);
    expect(j.lines.every((l: any) => l.in_cart && typeof l.found_quantity === 'number')).toBe(true);
    expect(j.progress).toMatchObject({ step: 'done', done: j.lines.length, total: j.lines.length });
  });

  it('waits and reads the cart again when it lags behind the writes', async () => {
    const t = await setup(false);
    t.shop.staleReads = 2;
    await t.add('leite', 2, 'un'); await t.add('arroz agulha', 1, 'kg');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j.status).toBe('done');
    expect(j.progress.verify_attempt).toBe(3);
    expect(t.shop.mutations()).toHaveLength(2);
  });

  it('names what is really missing and "retry missing" re-sends only those lines', async () => {
    const t = await setup(false);
    t.shop.dropFor.add('6600002');
    await t.add('leite', 2, 'un'); await t.add('arroz agulha', 1, 'kg');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j).toMatchObject({ status: 'needs_attention', message_key: 'basket.verify_mismatch' });
    expect(j.missing).toEqual([{ item_id: expect.any(Number), product_id: '6600002', name: 'Arroz Agulha Continente', desired: 1, found_quantity: null }]);
    expect(j.lines.find((l: any) => l.product_id === '4421406')).toMatchObject({ in_cart: true, found_quantity: 2 });
    t.shop.dropFor.clear();
    const before = t.shop.mutations().length;
    const r = await t.app.inject({ method: 'POST', url: `/api/v1/jobs/${j.job_id}/retry-missing`, headers: t.headers });
    expect(r.statusCode).toBe(202);
    const j2 = await t.finished(r.json().job_id);
    expect(j2).toMatchObject({ status: 'done', retry_of: j.job_id, missing: [] });
    expect(t.shop.mutations().slice(before).map(c => c.args)).toEqual([{ productId: '6600002', quantity: 1 }]);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/jobs/${j2.job_id}/retry-missing`, headers: t.headers })).statusCode).toBe(409);
  });

  it('test mode: progress still reported and the real cart is never touched', async () => {
    const t = await setup(true);
    await t.add('leite', 2, 'un');
    const p = await t.propose();
    const pv = (await t.preview(p.proposal_id)).json();
    const j = await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(j).toMatchObject({ status: 'simulated', progress: { step: 'done', done: 1, total: 1 } });
    expect(t.shop.mutations()).toHaveLength(0);
  });
});

describe('linked products (0.3.0, decision 58)', () => {
  const linked = { product_id: '2210001', name: 'Leite UHT Meio Gordo Continente', package_text: '1 lt', price: { amount: { currency: 'EUR', minorUnits: 72 }, per: 'item' },
    unit_price: { amount: { currency: 'EUR', minorUnits: 72 }, per: 'l' }, image_url: 'https://example.test/l.jpg', promotions: [{ kind: 'immediate_discount', label: '-15%' }], barcode: '5601234567890' };

  it('stores the linked product on the item and the basket uses it without matching again', async () => {
    const t = await setup(false);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: t.headers, payload: { name: 'Mimosa leite', quantity: 2, unit: 'un', product: linked } });
    expect(res.statusCode).toBe(201);
    expect(res.json().product).toMatchObject({ product_id: '2210001', barcode: '5601234567890', promotions: [{ label: '-15%' }] });
    const p = await t.propose();
    expect(p.lines[0]).toMatchObject({ needs_choice: false, quantity: 2, selected: { product_id: '2210001', reason: 'linked' } });
    expect(t.calls.filter(c => c.tool === 'search_products' && c.arg === 'Mimosa leite')).toHaveLength(0);
    const pv = (await t.preview(p.proposal_id)).json();
    await t.finished((await t.apply(p.proposal_id, pv.preview_id)).json().job_id);
    expect(t.shop.cart.get('2210001')).toBe(2);
  });

  it('can be unlinked with null and rejects invalid products', async () => {
    const t = await setup(false);
    const item = (await t.app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers: t.headers, payload: { name: 'leite', product: linked } })).json();
    const un = await t.app.inject({ method: 'PATCH', url: `/api/v1/items/${item.id}`, headers: t.headers, payload: { product: null } });
    expect(un.json().product).toBeNull();
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/v1/items/${item.id}`, headers: t.headers, payload: { product: { product_id: 'x', name: 'y' } } });
    expect(bad.json().error.message_key).toBe('error.invalid_product');
  });
});

describe('catalog search (0.3.0, decision 57)', () => {
  it('searches by barcode then name and returns candidates with price, unit price and promotions; read-only', async () => {
    const t = await setup(false);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/catalog/search', headers: t.headers, payload: { query: 'Leite Meio Gordo', barcode: '5601234567890' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.matched_by).toBe('name');
    expect(body.candidates.length).toBeGreaterThan(1);
    expect(body.candidates[0]).toHaveProperty('unit_price');
    expect(body.candidates[0]).toHaveProperty('promotions');
    expect(t.calls.filter(c => c.tool === 'search_products').map(c => c.arg)).toEqual(['5601234567890', 'Leite Meio Gordo']);
    expect(t.shop.mutations()).toHaveLength(0);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/catalog/search', headers: t.headers, payload: {} })).statusCode).toBe(400);
  });
});
