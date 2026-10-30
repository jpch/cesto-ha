import type { ToolResult } from './mcp/tools.js';

/** Subset of continentept-mcp product fields used by the matcher (docs/tools.md). */
export interface Money { currency: string; minorUnits: number }
export interface PriceTag { amount: Money; per: 'item' | 'piece' | 'kg' | 'l' }
export interface Qty { value: number; unit: 'un' | 'kg' | 'g' | 'l' | 'ml' }
export interface Promotion {
  kind: 'recommended_price' | 'immediate_discount' | 'multi_buy' | 'nth_unit_discount' | 'other';
  label: string;
  bundle?: { quantity: number; total: Money } | null;
  nthUnit?: number | null;
  percentOff?: number | null;
}
export interface SaleRules {
  status: 'available' | 'unavailable';
  rules?: { saleUnit: 'un' | 'kg'; storefrontUnit: 'un' | 'kg'; storefrontUnitsPerSaleUnit: number; minimum?: Qty; maximum?: Qty; step?: Qty };
}
export interface Product {
  productId: string;
  name: string;
  price?: PriceTag | null;
  packageText?: string | null;
  package?: { count: number; each: Qty | null; net: Qty | null; approximate?: boolean } | null;
  availability?: 'available' | 'unavailable' | 'unknown';
  promotions?: Promotion[];
  favorite?: boolean;
  imageUrl?: string | null;
  brand?: string | null;
  saleRules?: SaleRules;
}
export interface FrequentProduct { productId: string | null; name: string; orders?: number; orderCount?: number }

/** Read-only catalogue access; ContinenteMcp implements it. */
export interface CatalogReader {
  searchProducts(args: { query: string; limit?: number; favoritesFirst?: boolean }): Promise<ToolResult>;
  getProduct(productId: string): Promise<ToolResult>;
  listFrequentlyBought(args?: { orderLimit?: number; limit?: number }): Promise<ToolResult>;
  listFavorites(refresh?: boolean): Promise<ToolResult>;
}

/** Lower case, no accents, single spaces: the key shared preferences are stored under. */
export function itemKey(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function tokens(text: string): string[] {
  return itemKey(text).split(' ').filter(w => w.length > 1).map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}
