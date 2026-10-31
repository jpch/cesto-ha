import type { CatalogReader, Product } from '../../src/catalog.js';
import type { ToolResult } from '../../src/mcp/tools.js';

const eur = (c: number) => ({ currency: 'EUR', minorUnits: c });
const pack = (count: number, value: number, unit: 'g' | 'ml' | 'un') => ({ count, each: { value, unit }, net: { value: count * value, unit }, approximate: false });

/** Recorded-style product fixtures (shapes from continentept-mcp docs/tools.md). */
export const PRODUCTS: Product[] = [
  { productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa', price: { amount: eur(89), per: 'item' }, packageText: '1 lt', package: pack(1, 1000, 'ml'), availability: 'available', promotions: [] },
  { productId: '2210001', name: 'Leite UHT Meio Gordo Continente', price: { amount: eur(72), per: 'item' }, packageText: '1 lt', package: pack(1, 1000, 'ml'), availability: 'available', promotions: [] },
  { productId: '2210002', name: 'Leite UHT Magro Agros', price: { amount: eur(85), per: 'item' }, packageText: '1 lt', package: pack(1, 1000, 'ml'), availability: 'available', promotions: [] },
  { productId: '3300001', name: 'Iogurte Natural Danone', price: { amount: eur(250), per: 'item' }, packageText: '4 x 120 gr', package: pack(4, 120, 'g'), availability: 'available',
    promotions: [{ kind: 'multi_buy', label: 'Leve 3 Por 6€', bundle: { quantity: 3, total: eur(600) } }] },
  { productId: '3300002', name: 'Iogurte Grego Oikos', price: { amount: eur(299), per: 'item' }, packageText: '4 x 110 gr', package: pack(4, 110, 'g'), availability: 'available', promotions: [] },
  { productId: '3300003', name: 'Iogurte Líquido Morango Continente', price: { amount: eur(199), per: 'item' }, packageText: '6 x 170 gr', package: pack(6, 170, 'g'), availability: 'available', promotions: [] },
  { productId: '3300004', name: 'Iogurte Bifidus Activia', price: { amount: eur(310), per: 'item' }, packageText: '4 x 115 gr', package: pack(4, 115, 'g'), availability: 'available', promotions: [] },
  { productId: '3300005', name: 'Iogurte Natural Vigor', price: { amount: eur(150), per: 'item' }, packageText: '4 x 120 gr', package: pack(4, 120, 'g'), availability: 'available', promotions: [] },
  { productId: '5500001', name: 'Maçã Gala', price: { amount: eur(199), per: 'kg' }, packageText: 'emb. 1 kg aprox', package: null, availability: 'available', promotions: [],
    saleRules: { status: 'available', rules: { saleUnit: 'un', storefrontUnit: 'kg', storefrontUnitsPerSaleUnit: 0.2, minimum: { value: 1, unit: 'un' }, step: { value: 1, unit: 'un' } } } },
  { productId: '5500002', name: 'Queijo Flamengo Fatiado ao Corte', price: { amount: eur(999), per: 'kg' }, packageText: null, package: null, availability: 'available', promotions: [],
    saleRules: { status: 'available', rules: { saleUnit: 'kg', storefrontUnit: 'kg', storefrontUnitsPerSaleUnit: 1, minimum: { value: 0.1, unit: 'kg' }, step: { value: 0.05, unit: 'kg' } } } },
  { productId: '6600001', name: 'Arroz Agulha Cigala', price: { amount: eur(149), per: 'item' }, packageText: '1 kg', package: pack(1, 1000, 'g'), availability: 'unavailable', promotions: [] },
  { productId: '6600002', name: 'Arroz Agulha Continente', price: { amount: eur(115), per: 'item' }, packageText: '1 kg', package: pack(1, 1000, 'g'), availability: 'available', promotions: [] },
  { productId: '6600003', name: 'Arroz Carolino Saludães', price: { amount: eur(169), per: 'item' }, packageText: '1 kg', package: pack(1, 1000, 'g'), availability: 'available', promotions: [] },
  { productId: '6600004', name: 'Arroz Basmati Continente', price: { amount: eur(249), per: 'item' }, packageText: '1 kg', package: pack(1, 1000, 'g'), availability: 'available', promotions: [] },
  { productId: '6600005', name: 'Arroz Agulha Bom Sucesso', price: { amount: eur(139), per: 'item' }, packageText: '1 kg', package: pack(1, 1000, 'g'), availability: 'available', promotions: [] },
  { productId: '7700001', name: 'Ovos Classe M Continente', price: { amount: eur(219), per: 'item' }, packageText: '12 un', package: pack(12, 1, 'un'), availability: 'available',
    promotions: [{ kind: 'nth_unit_discount', label: '50% na 2ª un', nthUnit: 2, percentOff: 50 }] },
];

export function fixtureCatalog(over: { frequent?: string[]; favorites?: string[] } = {}) {
  const calls: { tool: string; arg: unknown }[] = [];
  const ok = (data: Record<string, unknown>): ToolResult => ({ status: 'success', data });
  const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const catalog: CatalogReader = {
    async searchProducts(args) {
      calls.push({ tool: 'search_products', arg: args.query });
      const words = strip(args.query).split(/\s+/).filter(w => w.length > 2).map(w => w.replace(/s$/, ''));
      const products = PRODUCTS.filter(p => words.some(w => strip(p.name).includes(w))).map(({ saleRules: _s, ...p }) => ({ ...p, favorite: (over.favorites ?? []).includes(p.productId) }));
      return products.length ? ok({ products }) : { status: 'empty', data: { products: [] } };
    },
    async getProduct(id) {
      calls.push({ tool: 'get_product', arg: id });
      const p = PRODUCTS.find(x => x.productId === id);
      return p ? ok({ ...p }) : { status: 'error', error: { code: 'not_found', message: 'not found' } };
    },
    async listFrequentlyBought() {
      calls.push({ tool: 'list_frequently_bought_products', arg: null });
      return ok({ products: (over.frequent ?? []).map((id, i) => ({ productId: id, name: PRODUCTS.find(p => p.productId === id)!.name, orderCount: 10 - i })) });
    },
    async listFavorites() {
      calls.push({ tool: 'list_favorites', arg: null });
      return ok({ favorites: PRODUCTS.filter(p => (over.favorites ?? []).includes(p.productId)) });
    },
  };
  return { catalog, calls };
}
