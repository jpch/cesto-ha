/**
 * The single place that knows continentept-mcp's result shapes.
 *
 * Every read of an upstream `data` field goes through an adapter here, so a shape change in a new
 * continentept-mcp release has one place to fix. The contract tests (test/contract/) run each adapter
 * on recorded, anonymised fixtures that are themselves validated against the output schemas the
 * installed package publishes over stdio (test/contract/upstream-tools.json).
 */
import type { FrequentProduct, Money, Product } from '../catalog.js';
import type { ToolResult } from './tools.js';

/** Package these adapters read. The checked version is in test/contract/upstream-tools.json. */
export const UPSTREAM_PACKAGE = 'continentept-mcp';

type Rec = Record<string, unknown>;
const dataOf = (r: ToolResult | undefined): Rec | undefined => (r?.data && typeof r.data === 'object' ? (r.data as Rec) : undefined);
const arrayAt = (r: ToolResult, key: string): Rec[] => {
  const v = dataOf(r)?.[key];
  return Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Rec[]) : [];
};

/** True when continentept-mcp says the saved session is missing or expired. */
export const isNotAuthenticated = (r: ToolResult | undefined): boolean => r?.error?.code === 'not_authenticated';

// ---- catalogue -------------------------------------------------------------------------------

/** search_products: the products of one page, without entries lacking a product id. */
export const productsOf = (r: ToolResult): Product[] => arrayAt(r, 'products').filter(p => p.productId) as unknown as Product[];
/** get_product: the product, or null on an error or empty result. */
export const productOf = (r: ToolResult): Product | null => (r.status !== 'error' && dataOf(r)?.productId ? (dataOf(r) as unknown as Product) : null);
/** list_favorites. */
export const favoritesOf = (r: ToolResult): Product[] => arrayAt(r, 'favorites') as unknown as Product[];
/** list_frequently_bought_products. */
export const frequentOf = (r: ToolResult): FrequentProduct[] => arrayAt(r, 'products') as unknown as FrequentProduct[];

// ---- cart --------------------------------------------------------------------------------------

/** quantity is null when the line is in the cart but its quantity could not be read. */
export interface CartItem { productId: string; quantity: number | null }

/**
 * A cart line quantity: `{status:'known', quantity:{value, unit}}` or `{status:'unknown', value}`;
 * plain numbers are accepted too. Reading it with Number() gave NaN, so every verified line looked
 * missing (the 0.2.0 "needs attention" bug).
 */
export function cartQuantityOf(q: unknown): number | null {
  if (typeof q === 'number') return Number.isFinite(q) ? q : null;
  if (typeof q === 'string' && q.trim() && Number.isFinite(Number(q))) return Number(q);
  if (q && typeof q === 'object') {
    const o = q as { status?: unknown; quantity?: { value?: unknown } | number; value?: unknown };
    if (o.status === 'known' && o.quantity && typeof o.quantity === 'object') return cartQuantityOf(o.quantity.value);
    if (o.status === 'known' && typeof o.quantity === 'number') return cartQuantityOf(o.quantity);
    if ('value' in o) return cartQuantityOf(o.value);
  }
  return null;
}

/** get_cart: product lines (bags are left out). */
export const cartItems = (r: ToolResult): CartItem[] =>
  arrayAt(r, 'items')
    .filter(i => i.productId != null && i.kind !== 'bag')
    .map(i => ({ productId: String(i.productId), quantity: cartQuantityOf(i.quantity) }));

/** A line continentept-mcp would refuse, or whose product is not available. */
export interface PreviewProblem { product_id: string; name: string | null; availability: string | null; error_key: string | null }

/**
 * preview_cart_changes reports `problems` as a count and the details on each line; the API always
 * returns a list (the phone app parses it as one).
 */
export function previewProblems(r: ToolResult | undefined): PreviewProblem[] {
  const lines = Array.isArray(dataOf(r)?.lines) ? (dataOf(r)!.lines as Rec[]) : [];
  return lines
    .filter(l => l && (l.error != null || (l.availability != null && l.availability !== 'available')))
    .map(l => ({
      product_id: String(l.productId ?? ''),
      name: typeof l.name === 'string' ? l.name : null,
      availability: typeof l.availability === 'string' ? l.availability : null,
      error_key: l.error && typeof (l.error as { code?: unknown }).code === 'string' ? `error.${(l.error as { code: string }).code}` : null,
    }));
}
/** preview_cart_changes: the estimated cost of the products changed, or null. */
export const estimatedCostOf = (r: ToolResult): Money | null => (dataOf(r)?.estimatedCost as Money | null | undefined) ?? null;

export type MutationOutcome = 'confirmed' | 'not_applied' | 'unknown' | 'simulated';
/**
 * Outcome of a cart mutation: `data.outcome` on success, `mutation.outcome` on an error. Anything
 * unreadable is `unknown`, which stops a job and is never replayed.
 */
export function mutationOutcome(r: ToolResult): MutationOutcome {
  if (r.simulated) return 'simulated';
  const o = (r as { mutation?: { outcome?: unknown } }).mutation?.outcome ?? dataOf(r)?.outcome;
  if (o === 'confirmed' || o === 'not_applied' || o === 'unknown') return o;
  return r.status === 'error' && o === undefined ? 'not_applied' : 'unknown';
}

// ---- session -----------------------------------------------------------------------------------

export type SessionState = 'authenticated' | 'unauthenticated' | 'unknown';
/** get_session_status: the authentication state, `unknown` when unreadable. */
export function sessionStateOf(r: ToolResult): SessionState {
  if (isNotAuthenticated(r)) return 'unauthenticated';
  const s = (dataOf(r)?.authentication as { state?: unknown } | undefined)?.state;
  return s === 'authenticated' || s === 'unauthenticated' ? s : 'unknown';
}
