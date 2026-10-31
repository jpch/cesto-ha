import { describe, expect, it } from 'vitest';
import { PromotionService } from '../src/promotions.js';
import type { CatalogReader, Product } from '../src/catalog.js';
import type { Item } from '../src/lists.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { asLan, testConfig } from './helpers.js';

const eur = (minorUnits: number) => ({ currency: 'EUR', minorUnits });
const prod = (id: string, name: string, unit: number | null, promo = false): Product => ({
  productId: id, name, price: { amount: eur(100), per: 'item' }, availability: 'available',
  unitPrice: unit ? { amount: eur(unit), per: 'l' } : null,
  promotions: promo ? [{ kind: 'immediate_discount', label: '-20%', percentOff: 20 }] : [],
});
const item = (id: number, name: string) => ({ id, name, state: 'pending', deleted: false, category: null } as unknown as Item);

const beer = [
  prod('sel', 'Cerveja Super Bock Mini 30x25cl', 199),
  prod('p1', 'Cerveja Super Bock 6x33cl', 197, true),
  prod('p2', 'Cerveja Super Bock 24x25cl', 150, true),
  prod('c1', 'Cerveja Sagres Mini 24x25cl', 175),
  prod('c2', 'Cerveja Super Bock 12x33cl', 189),
  prod('x', 'Cerveja cara', 250),
];
const catalog = (getProduct: (id: string) => Product | null = () => null): CatalogReader => ({
  async searchProducts() { return { status: 'success', data: { products: beer } } as never; },
  async getProduct(id) { const p = getProduct(id); return (p ? { status: 'success', data: p } : { status: 'error', error: { code: 'not_found' } }) as never; },
  async listFrequentlyBought() { return {} as never; }, async listFavorites() { return {} as never; },
});

describe('items[] per searched item (1.6.0)', () => {
  it('one deduplicated cheaper list against the selected product, without promotions or the selection', async () => {
    const r = await new PromotionService(catalog(), null, 'pt-PT').suggest([item(1, 'Cerveja Super Bock')],
      { selected: new Map([[1, { product_id: 'sel', unit_price: { amount: eur(199), per: 'l' as const } }]]) });
    expect(r.items).toHaveLength(1);
    const it0 = r.items[0]!;
    expect(it0.selected_product_id).toBe('sel');
    expect(it0.basis).toEqual({ unit_price: { amount: eur(199), per: 'l' }, source: 'selected' });
    expect(it0.promotions.map(p => p.product_id)).toEqual(['p1', 'p2']);
    expect(it0.cheaper.map(p => p.product_id)).toEqual(['c1', 'c2']);
    // Old field kept for older apps: one suggestion per promotion.
    expect(r.suggestions).toHaveLength(2);
  });

  it('reads the unit price of the selection from the search results, then from get_product', async () => {
    const a = await new PromotionService(catalog(), null, 'pt-PT').suggest([item(1, 'Cerveja')], { selected: new Map([[1, { product_id: 'sel' }]]) });
    expect(a.items[0]!.basis?.unit_price.amount.minorUnits).toBe(199);
    const other = prod('ext', 'Cerveja importada', 300);
    const b = await new PromotionService(catalog(id => (id === 'ext' ? other : null)), null, 'pt-PT').suggest([item(1, 'Cerveja')], { selected: new Map([[1, { product_id: 'ext' }]]) });
    expect(b.items[0]!.basis?.unit_price.amount.minorUnits).toBe(300);
    expect(b.items[0]!.cheaper.map(p => p.product_id)).toEqual(['c1', 'c2', 'sel', 'x']);
  });

  it('a selected product on promotion is not repeated in the promotions block', async () => {
    const r = await new PromotionService(catalog(), null, 'pt-PT').suggest([item(1, 'Cerveja')], { selected: new Map([[1, { product_id: 'p1' }]]) });
    expect(r.items[0]!.promotions.map(p => p.product_id)).toEqual(['p2']);
    expect(r.items[0]!.cheaper.map(p => p.product_id)).toEqual(['c1', 'c2']);
  });

  it('without a selection the first promotion is the basis', async () => {
    const r = await new PromotionService(catalog(), null, 'pt-PT').suggest([item(1, 'Cerveja')]);
    expect(r.items[0]!.basis?.source).toBe('promotion');
    expect(r.items[0]!.cheaper.map(p => p.product_id)).toEqual(['c1', 'c2']);
  });

  it('POST /promotions/searches validates proposal_id', async () => {
    const app = buildApp({ config: testConfig({ testMode: false }), db: openDatabase(':memory:'), version: 't', catalog: catalog(), ai: null });
    const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
    asLan(app);
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/v1/promotions/searches', headers, payload: { proposal_id: '../x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/promotions/searches', headers, payload: { proposal_id: '00000000-0000-0000-0000-000000000000' } })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: '/api/v1/promotions/searches', headers })).statusCode).toBe(202);
  });
});
