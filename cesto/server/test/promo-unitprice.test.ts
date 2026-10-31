import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { cheaperPerUnit, productType } from '../src/promotions.js';
import type { CatalogReader, Product } from '../src/catalog.js';
import { asLan, testConfig } from './helpers.js';

const eur = (minorUnits: number) => ({ currency: 'EUR', minorUnits });
const prod = (id: string, name: string, unit: [number, 'kg' | 'l'] | null, promo = false): Product => ({
  productId: id, name, price: { amount: eur(100), per: 'item' }, availability: 'available',
  unitPrice: unit ? { amount: eur(unit[0]), per: unit[1] } : null,
  promotions: promo ? [{ kind: 'immediate_discount', label: '-20%', percentOff: 20 }] : [],
});

describe('cheaper per unit', () => {
  const promo = prod('p', 'Leite Mimosa Meio-Gordo 1L', [89, 'l'], true);
  const related = [
    promo,
    prod('a', 'Leite Agros M-G 1,5L', [83, 'l'], true), // promoted too: still listed
    prod('b', 'Leite Continente M-G 6x1L', [75, 'l']), // other brand and pack size
    prod('c', 'Leite Gresso 1L', [89, 'l']), // same price: not strictly lower
    prod('d', 'Leite em pó 1kg', [50, 'kg']), // other unit
    prod('e', 'Leite sem preço por litro', null), // no unit price
    prod('f', 'Bebida de aveia', [60, 'l']), // other product type
  ];
  it('keeps only the same type and unit, strictly cheaper, cheapest first', () => {
    expect(cheaperPerUnit(promo, related, 'Leite meio-gordo').map(p => p.productId)).toEqual(['b', 'a']);
  });
  it('nothing when the promoted product has no unit price', () => {
    expect(cheaperPerUnit(prod('x', 'Leite', null, true), related, 'leite')).toEqual([]);
  });
  it('type word ignores accents and short words', () => expect(productType('Açúcar de cana')).toBe('acucar'));
});

describe('async promotion search', () => {
  async function setup(gate: Promise<void>) {
    const results: Record<string, Product[]> = {
      leite: [prod('p', 'Leite Mimosa 1L', [89, 'l'], true), prod('b', 'Leite Continente 6x1L', [75, 'l'])],
      arroz: [prod('r', 'Arroz Cigala 1kg', [139, 'kg'], true)],
      iogurte: [prod('i', 'Iogurte morango', [300, 'kg'])],
    };
    const catalog: CatalogReader = {
      async searchProducts({ query }) { await gate; return { status: 'ok', data: { products: results[query.toLowerCase()] ?? [] } } as never; },
      async getProduct() { return {} as never; }, async listFrequentlyBought() { return {} as never; }, async listFavorites() { return {} as never; },
    };
    const app = buildApp({ config: testConfig({ testMode: false }), db: openDatabase(':memory:'), version: '1.4.0', catalog, ai: null });
    const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
    const headers = { authorization: `Bearer ${token}` };
    asLan(app);
    for (const name of ['Leite', 'Arroz', 'Iogurte'])
      await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name } });
    return { app, headers };
  }

  it('reports per-item progress and finishes with unit-price alternatives', async () => {
    let open!: () => void;
    const { app, headers } = await setup(new Promise<void>(r => { open = r; }));
    const start = await app.inject({ method: 'POST', url: '/api/v1/promotions/searches', headers });
    expect(start.statusCode).toBe(202);
    const id = start.json().search_id;
    const running = (await app.inject({ url: `/api/v1/promotions/searches/${id}`, headers })).json();
    expect(running).toMatchObject({ status: 'running', done: 0, total: 3 });
    expect(running.items.map((i: { status: string }) => i.status)).toEqual(['searching', 'queued', 'queued']);
    open();
    await new Promise(r => setTimeout(r, 20));
    const done = (await app.inject({ url: `/api/v1/promotions/searches/${id}`, headers })).json();
    expect(done).toMatchObject({ status: 'done', done: 3 });
    expect(done.items[0]).toMatchObject({ status: 'done', promos: 1, cheaper: 1 });
    expect(done.items[2]).toMatchObject({ promos: 0, cheaper: 0 });
    const milk = done.result.suggestions.find((s: { item_name: string }) => s.item_name === 'Leite');
    expect(milk.product).toMatchObject({ unit_price: { per: 'l' }, discount_percent: 20 });
    expect(milk.cheaper.map((c: { product_id: string }) => c.product_id)).toEqual(['b']);
  });

  it('cancel stops after the current item and keeps partial results', async () => {
    let open!: () => void;
    const { app, headers } = await setup(new Promise<void>(r => { open = r; }));
    const id = (await app.inject({ method: 'POST', url: '/api/v1/promotions/searches', headers })).json().search_id;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/promotions/searches/${id}`, headers })).statusCode).toBe(200);
    open();
    await new Promise(r => setTimeout(r, 20));
    const s = (await app.inject({ url: `/api/v1/promotions/searches/${id}`, headers })).json();
    expect(s).toMatchObject({ status: 'cancelled', done: 1 });
    expect(s.result.suggestions).toHaveLength(1);
    expect((await app.inject({ url: '/api/v1/promotions/searches/nope', headers })).statusCode).toBe(404);
  });
});
