import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { HabitsService, PreferenceStore } from '../src/habits.js';
import { cartQuantity, Matcher, promoSuggestion } from '../src/matcher.js';
import { itemKey } from '../src/catalog.js';
import { fixtureCatalog, PRODUCTS } from './fixtures/catalog.js';

const product = (id: string) => PRODUCTS.find(p => p.productId === id)!;

async function setup(over: { frequent?: string[]; favorites?: string[] } = {}) {
  const db = openDatabase(':memory:');
  const { catalog, calls } = fixtureCatalog(over);
  const prefs = new PreferenceStore(db);
  const habitsService = new HabitsService(db, catalog);
  const habits = await habitsService.refresh();
  const matcher = new Matcher(catalog, prefs);
  const match = (name: string, quantity: number | null = null, unit: string | null = null) => matcher.match({ id: 1, name, quantity, unit }, habits);
  return { db, prefs, match, calls, habitsService };
}

describe('matcher', () => {
  it('selects the frequently bought product and offers alternatives', async () => {
    const { match } = await setup({ frequent: ['2210001'] });
    const line = await match('leite meio gordo', 6, 'un');
    expect(line.selected).toMatchObject({ product_id: '2210001', reason: 'frequent' });
    expect(line.needs_choice).toBe(false);
    expect(line.quantity).toBe(6);
    expect(line.options.length).toBeGreaterThan(0);
    expect(line.options.length).toBeLessThanOrEqual(3);
  });

  it('a favourite wins over plain search results', async () => {
    const { match } = await setup({ favorites: ['2210002'] });
    expect((await match('leite')).selected).toMatchObject({ product_id: '2210002', reason: 'favorite' });
  });

  it('generic items without history get 2-4 options and need a choice', async () => {
    const { match } = await setup();
    const line = await match('iogurtes');
    expect(line.selected).toBeNull();
    expect(line.needs_choice).toBe(true);
    expect(line.options.length).toBeGreaterThanOrEqual(2);
    expect(line.options.length).toBeLessThanOrEqual(4);
  });

  it('a learned preference wins over frequent products and is reused next run', async () => {
    const { match, prefs } = await setup({ frequent: ['4421406'] });
    expect((await match('Leite')).selected!.product_id).toBe('4421406');
    prefs.set(itemKey('Leite'), '2210002', null, 'Ana');
    const next = await match('leite');
    expect(next.selected).toMatchObject({ product_id: '2210002', reason: 'preference' });
    expect(next.needs_choice).toBe(false);
  });

  it('out of stock usual product: no selection, up to 3 available alternatives', async () => {
    const { match } = await setup({ frequent: ['6600001'] });
    const line = await match('arroz agulha');
    expect(line.out_of_stock).toBe(true);
    expect(line.unavailable).toMatchObject({ product_id: '6600001' });
    expect(line.selected).toBeNull();
    expect(line.needs_choice).toBe(true);
    expect(line.options.length).toBeGreaterThan(0);
    expect(line.options.length).toBeLessThanOrEqual(3);
    expect(line.options.every(o => o.availability === 'available' && o.product_id !== '6600001')).toBe(true);
  });

  it('weighed products: kg to pieces using the sale rules', async () => {
    const { match, calls } = await setup({ frequent: ['5500001'] });
    const line = await match('maçãs', 1, 'kg');
    expect(line).toMatchObject({ quantity: 5, quantity_basis: 'weighed_pieces' });
    expect(calls.some(c => c.tool === 'get_product' && c.arg === '5500001')).toBe(true);
  });

  it('no match is reported, not guessed', async () => {
    const { match } = await setup();
    const line = await match('caviar beluga');
    expect(line).toMatchObject({ selected: null, options: [], error: 'no_match' });
  });

  it('habits cache is reused within a day', async () => {
    const { habitsService, calls } = await setup({ frequent: ['4421406'] });
    const before = calls.length;
    await habitsService.fresh();
    expect(calls.length).toBe(before);
  });
});

describe('cart quantities', () => {
  const cases: [number | null, string | null, string, number, string][] = [
    [null, null, '4421406', 1, 'default'],
    [6, 'un', '4421406', 6, 'units'],
    [2, 'l', '4421406', 2, 'packs'],
    [1500, 'ml', '4421406', 2, 'packs'],
    [1.5, 'kg', '6600002', 2, 'packs'],
    [500, 'g', '3300001', 2, 'packs'],
    [480, 'g', '3300001', 1, 'packs'],
    [1, 'kg', '5500001', 5, 'weighed_pieces'],
    [0.1, 'kg', '5500001', 1, 'weighed_pieces'],
    [0.33, 'kg', '5500002', 0.35, 'weight'],
    [0.02, 'kg', '5500002', 0.1, 'weight'],
    [2, 'kg', '4421406', 1, 'default'],
  ];
  it.each(cases)('%s %s of %s -> %s (%s)', (quantity, unit, id, expected, basis) => {
    expect(cartQuantity({ quantity, unit }, product(id))).toEqual({ quantity: expected, basis });
  });
});

describe('promotion suggestions', () => {
  it('suggests completing a multi-buy or nth-unit offer', () => {
    expect(promoSuggestion(product('3300001'), 2)).toEqual({ kind: 'multi_buy', label: 'Leve 3 Por 6€', suggested_quantity: 3 });
    expect(promoSuggestion(product('3300001'), 3)).toBeNull();
    expect(promoSuggestion(product('7700001'), 1)).toMatchObject({ kind: 'nth_unit_discount', suggested_quantity: 2 });
    expect(promoSuggestion(product('4421406'), 1)).toBeNull();
  });
});
