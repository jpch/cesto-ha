/**
 * continentept-mcp 0.15.0 in Cesto 2.0.4: no favoritesFirst (five results pages per search since 0.14.0),
 * favourites from Cesto's own cache, `per: "dose"` only for apps that can show it, `takePay` offers.
 * No Continente login, no network.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogReader, Product } from '../src/catalog.js';
import { openDatabase } from '../src/db.js';
import { HabitsService, PreferenceStore, type Habits } from '../src/habits.js';
import { MAX_CACHED_FAVORITES, Matcher, promoSuggestion, withCachedFavorites } from '../src/matcher.js';
import { ContinenteMcp, TestModeGuard } from '../src/mcp/continente.js';
import type { McpTransport } from '../src/mcp/client.js';
import type { ToolResult } from '../src/mcp/tools.js';
import { productsOf } from '../src/mcp/upstream.js';
import { cheaperPerUnit } from '../src/promotions.js';
import { ProductSearch } from '../src/search.js';
import { UNITS_HEADER, clientUnits, forUnits } from '../src/units.js';
import { buildApp } from '../src/app.js';
import { asLan, testConfig } from './helpers.js';
import { fx } from './contract/support.js';
import { fixtureCatalog, PRODUCTS } from './fixtures/catalog.js';

const eur = (c: number) => ({ currency: 'EUR', minorUnits: c });
const ok = (data: Record<string, unknown>): ToolResult => ({ status: 'success', data });
const noHabits: Habits = { frequent: [], favorites: [], fetched_at: null };

describe('favourites without favoritesFirst', () => {
  it('ContinenteMcp never sends favoritesFirst, even if a caller passes it', async () => {
    const sent: Record<string, unknown>[] = [];
    const t: McpTransport = { async callTool(_n, a) { sent.push(a); return ok({ products: [] }); }, async close() {} };
    const mcp = new ContinenteMcp(new TestModeGuard(t, () => false));
    await mcp.searchProducts({ query: 'leite', limit: 10, favoritesFirst: true } as never);
    await mcp.searchProducts({ query: 'pão' });
    expect(sent).toEqual([{ query: 'leite', limit: 10 }, { query: 'pão' }]);
  });

  it('the matcher (including the out-of-stock path) and the photo search never ask for it', async () => {
    const args: Record<string, unknown>[] = [];
    const { catalog } = fixtureCatalog();
    const spy: CatalogReader = { ...catalog, searchProducts: a => { args.push(a); return catalog.searchProducts(a); } };
    const m = new Matcher(spy, new PreferenceStore(openDatabase(':memory:')));
    await m.match({ id: 1, name: 'leite', quantity: null, unit: null }, noHabits);
    await m.match({ id: 2, name: 'arroz', quantity: null, unit: null, product: { product_id: '6600001', name: 'Arroz Agulha Cigala', package_text: null, price: null, image_url: null } as never }, noHabits);
    await new ProductSearch(spy).search({ query: 'iogurte' });
    expect(args.length).toBe(3);
    for (const a of args) expect(a).not.toHaveProperty('favoritesFirst');
  });

  it('a cached favourite further down the results is still chosen, with no extra upstream call', async () => {
    const db = openDatabase(':memory:');
    const { catalog, calls } = fixtureCatalog();
    // The page shows other rices only; the household favourite is in the cache from list_favorites.
    const page: CatalogReader = { ...catalog, async searchProducts(a) { calls.push({ tool: 'search_products', arg: a.query }); return ok({ products: PRODUCTS.filter(p => ['6600002', '6600003'].includes(p.productId)) }); } };
    const favourite = { ...PRODUCTS.find(p => p.productId === '6600005')! };
    const habits: Habits = { frequent: [], favorites: [favourite], fetched_at: new Date().toISOString() };
    const line = await new Matcher(page, new PreferenceStore(db)).match({ id: 1, name: 'arroz agulha', quantity: 2, unit: 'un' }, habits);
    expect(line.selected).toMatchObject({ product_id: '6600005', reason: 'favorite' });
    expect(calls.map(c => c.tool)).toEqual(['search_products']);
  });

  it('only cached favourites with every word of the item are added, at most a few', () => {
    const words = ['arroz', 'agulha'];
    const favs = PRODUCTS.filter(p => p.name.startsWith('Arroz') || p.name.startsWith('Leite'));
    const out = withCachedFavorites([], favs, words);
    expect(out.map(p => p.productId)).toEqual(['6600001', '6600002', '6600005'].slice(0, MAX_CACHED_FAVORITES));
    expect(out.every(p => p.favorite === true)).toBe(true);
    // Already on the page: not duplicated.
    expect(withCachedFavorites([PRODUCTS.find(p => p.productId === '6600002')!], favs, words).map(p => p.productId)).toEqual(['6600002', '6600001', '6600005']);
    expect(withCachedFavorites([], favs, [])).toEqual([]);
  });

  it('the photo search shows favourites first (shop flag or Cesto cache), then the shop order', async () => {
    const products = ['2210001', '2210002', '4421406'].map(id => ({ ...PRODUCTS.find(p => p.productId === id)!, favorite: id === '4421406' }));
    const catalog: CatalogReader = { ...fixtureCatalog().catalog, async searchProducts() { return ok({ products }); } };
    const r = await new ProductSearch(catalog, () => new Set(['2210002'])).search({ query: 'leite' });
    expect(r.candidates.map(c => c.product_id)).toEqual(['2210002', '4421406', '2210001']);
  });
});

/**
 * Mocked upstream with continentept-mcp's paging cost: a search reads one results page, or up to five with
 * favoritesFirst (0.14.0+). Each page read takes PAGE_MS.
 */
const PAGE_MS = 15;
function pagedUpstream(version: '0.13.0' | '0.15.0', forceFavoritesFirst: boolean) {
  const stats = { calls: 0, pages: 0 };
  const { catalog } = fixtureCatalog({ favorites: ['2210002', '6600005'] });
  const transport: McpTransport = {
    async callTool(name, a) {
      stats.calls++;
      const args = forceFavoritesFirst && name === 'search_products' ? { ...a, favoritesFirst: true } : a;
      if (name !== 'search_products') return catalog.getProduct(String(args.productId));
      const pages = args.favoritesFirst === true && version !== '0.13.0' ? 5 : 1;
      stats.pages += pages;
      await new Promise(r => setTimeout(r, pages * PAGE_MS));
      return catalog.searchProducts({ query: String(args.query), limit: Number(args.limit ?? 10) });
    },
    async close() {},
  };
  return { mcp: new ContinenteMcp(new TestModeGuard(transport, () => true)), stats };
}

describe('perf: favourites from the cache cost no extra results pages', () => {
  const ITEMS = ['leite', 'iogurte natural', 'arroz agulha', 'maçã', 'ovos', 'queijo flamengo', 'leite magro', 'arroz basmati'];
  const run = async (version: '0.13.0' | '0.15.0', legacy: boolean) => {
    const { mcp, stats } = pagedUpstream(version, legacy);
    const db = openDatabase(':memory:');
    const habits = await new HabitsService(db, fixtureCatalog({ favorites: ['2210002', '6600005'] }).catalog).refresh();
    const matcher = new Matcher(mcp, new PreferenceStore(db));
    const t0 = performance.now();
    const lines = [];
    for (const [i, name] of ITEMS.entries()) lines.push(await matcher.match({ id: i, name, quantity: null, unit: null }, habits));
    return { ...stats, ms: Math.round(performance.now() - t0), picks: lines.map(l => l.selected?.product_id ?? null) };
  };

  it('2.0.4 on 0.15.0 reads no more pages or calls than 2.0.3 on 0.13.0, and is faster than favoritesFirst on 0.15.0', async () => {
    const today = await run('0.13.0', true); // 2.0.3 (favoritesFirst) against the add-on 1.0.3
    const naive = await run('0.15.0', true); // 2.0.3 against 0.15.0: five pages per search
    const after = await run('0.15.0', false); // 2.0.4 against 0.15.0
    const after013 = await run('0.13.0', false); // 2.0.4 against the add-on 1.0.3 (release order)
    console.log(`[perf] ${ITEMS.length} items, ${PAGE_MS} ms/page: 2.0.3+0.13 ${JSON.stringify({ calls: today.calls, pages: today.pages, ms: today.ms })}; `
      + `2.0.3+0.15 ${JSON.stringify({ calls: naive.calls, pages: naive.pages, ms: naive.ms })}; 2.0.4+0.15 ${JSON.stringify({ calls: after.calls, pages: after.pages, ms: after.ms })}; `
      + `2.0.4+0.13 ${JSON.stringify({ calls: after013.calls, pages: after013.pages, ms: after013.ms })}`);
    expect(after.pages).toBe(ITEMS.length);
    expect(after.pages).toBeLessThanOrEqual(today.pages);
    expect(after.calls).toBeLessThanOrEqual(today.calls);
    expect(naive.pages).toBe(ITEMS.length * 5);
    expect(after.ms).toBeLessThan(naive.ms);
    expect(after.ms).toBeLessThanOrEqual(today.ms * 1.5 + 50);
    // Same choices as today: favourites still win.
    expect(after.picks).toEqual(today.picks);
    expect(after013.picks).toEqual(today.picks);
    expect(after.picks).toContain('2210002');
  });
});

describe('takePay (Leve X Pague Y)', () => {
  it('suggests the take quantity for a takePay multi-buy close to the wanted quantity', () => {
    const p = productsOf(fx('search_products.dose'))[0]!;
    expect(p.promotions?.[0]).toMatchObject({ kind: 'multi_buy', takePay: { take: 2, pay: 1 }, bundle: null });
    expect(promoSuggestion(p, 1)).toEqual({ kind: 'multi_buy', label: 'Leve 2 Pague 1', suggested_quantity: 2 });
    expect(promoSuggestion(p, 2)).toBeNull();
    expect(promoSuggestion({ ...p, promotions: [{ kind: 'multi_buy', label: 'Leve 6 Pague 5', takePay: { take: 6, pay: 5 } }] }, 1)).toBeNull();
    expect(promoSuggestion({ ...p, promotions: [{ kind: 'multi_buy', label: 'Leve 6 Pague 5', takePay: { take: 6, pay: 5 } }] }, 4)).toMatchObject({ suggested_quantity: 6 });
  });
});

describe('per dose', () => {
  const dose = productsOf(fx('search_products.dose'));
  const kg = PRODUCTS[8]!; // per kg
  it('cheaper products compare dose with dose only', () => {
    const base = { productId: 'x', unitPrice: { amount: eur(30), per: 'dose' as const } };
    const related: Product[] = [...dose.map(p => ({ ...p, name: `Detergente ${p.name}` })), { ...kg, unitPrice: { amount: eur(1), per: 'kg' } }];
    expect(cheaperPerUnit(base, related, 'detergente').map(p => p.productId)).toEqual(['2000011', '2000010']);
  });

  it('clientUnits always includes kg and l and accepts only known units', () => {
    expect([...clientUnits(undefined)].sort()).toEqual(['kg', 'l']);
    expect([...clientUnits('kg,l,dose')].sort()).toEqual(['dose', 'kg', 'l']);
    expect([...clientUnits(' DOSE , m3 ')].sort()).toEqual(['dose', 'kg', 'l']);
    expect([...clientUnits(['dose'])].sort()).toEqual(['dose', 'kg', 'l']);
  });

  it('forUnits hides dose unit prices, cheaper products and bases from older apps, leaving the rest', () => {
    const payload = {
      lines: [{ selected: { product_id: '1', unit_price: { amount: eur(25), per: 'dose' }, price: { amount: eur(999), per: 'item' } } },
        { selected: { product_id: '2', unit_price: { amount: eur(100), per: 'l' } } }],
      items: [{ basis: { unit_price: { amount: eur(25), per: 'dose' }, source: 'selected' },
        cheaper: [{ product_id: '3', unit_price: { amount: eur(20), per: 'dose' } }, { product_id: '4', unit_price: { amount: eur(90), per: 'kg' } }] }],
      raw: { unitPrice: { amount: eur(25), per: 'dose' } },
    };
    const old = forUnits(payload, clientUnits(undefined));
    expect(old.lines[0]!.selected.unit_price).toBeNull();
    expect(old.lines[0]!.selected.price).toEqual({ amount: eur(999), per: 'item' });
    expect(old.lines[1]!.selected.unit_price).toEqual({ amount: eur(100), per: 'l' });
    expect(old.items[0]!.basis).toBeNull();
    expect(old.items[0]!.cheaper.map(c => c.product_id)).toEqual(['4']);
    expect(old.raw.unitPrice).toBeNull();
    expect(payload.lines[0]!.selected.unit_price).not.toBeNull();
    expect(forUnits(payload, clientUnits('kg,l,dose'))).toEqual(payload);
  });

  it('over the API: an app without X-Cesto-Units never sees per dose; one that lists dose does', async () => {
    const catalog: CatalogReader = { ...fixtureCatalog().catalog, async searchProducts() { return fx('search_products.dose'); } };
    const db = openDatabase(':memory:');
    const app = buildApp({ config: testConfig({ testMode: true }), db, version: '2.0.4', catalog });
    const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Phone', kind: 'phone' } })).json().token as string;
    asLan(app);
    const search = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/catalog/search', headers: { authorization: `Bearer ${token}`, ...headers }, payload: { query: 'detergente' } });
    const old = (await search({})).json();
    expect(old.candidates).toHaveLength(2);
    expect(old.candidates.map((c: { unit_price: unknown }) => c.unit_price)).toEqual([null, null]);
    expect(JSON.stringify(old)).not.toContain('"dose"');
    const fresh = (await search({ [UNITS_HEADER]: 'kg,l,dose' })).json();
    expect(fresh.candidates[0].unit_price).toEqual({ amount: eur(25), per: 'dose', basis: 'website' });
    expect(fresh.candidates[0].promotions[0].takePay).toEqual({ take: 2, pay: 1 });
  });
});
