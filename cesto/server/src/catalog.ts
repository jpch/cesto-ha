import type { ToolResult } from './mcp/tools.js';

/** Subset of continentept-mcp product fields used by the matcher (docs/tools.md). */
export interface Money { currency: string; minorUnits: number }
/** What a price is for. continentept-mcp 0.14.0+ adds `dose` (detergents, per wash). */
export type PricePer = 'item' | 'piece' | 'kg' | 'l' | 'dose';
export type UnitPer = 'kg' | 'l' | 'dose';
export interface PriceTag { amount: Money; per: PricePer }
export interface Qty { value: number; unit: 'un' | 'kg' | 'g' | 'l' | 'ml' }
export interface Promotion {
  kind: 'recommended_price' | 'immediate_discount' | 'multi_buy' | 'nth_unit_discount' | 'other';
  label: string;
  bundle?: { quantity: number; total: Money } | null;
  nthUnit?: number | null;
  percentOff?: number | null;
  /** continentept-mcp 0.14.0+: `Leve 6 Pague 5` as `{ take: 6, pay: 5 }` (absent before, null when not that offer). */
  takePay?: { take: number; pay: number } | null;
}
export interface SaleRules {
  status: 'available' | 'unavailable';
  rules?: { saleUnit: 'un' | 'kg'; storefrontUnit: 'un' | 'kg'; storefrontUnitsPerSaleUnit: number; minimum?: Qty; maximum?: Qty; step?: Qty };
}
export interface Product {
  productId: string;
  name: string;
  price?: PriceTag | null;
  /** Price per kg, l or (0.14.0+) dose, when the shop shows one. */
  unitPrice?: { amount: Money; per: UnitPer; basis?: string } | null;
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
  /**
   * Cesto never asks for `favoritesFirst`: since continentept-mcp 0.14.0 it reads up to five results pages per
   * search. Favourites are promoted from Cesto's own cached list_favorites instead (matcher.ts, search.ts).
   */
  searchProducts(args: { query: string; limit?: number }): Promise<ToolResult>;
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
