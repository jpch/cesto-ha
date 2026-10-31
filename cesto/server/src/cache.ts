import type { CatalogReader } from './catalog.js';
import type { ToolResult } from './mcp/tools.js';

export const SEARCH_TTL_MS = 8 * 3600_000;
export const PRODUCT_TTL_MS = 6 * 3600_000;
export const CACHE_MAX_ENTRIES = 500;

/** In-memory TTL cache with a size bound (oldest entry evicted first). Lost on restart by design. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;
  constructor(private readonly ttlMs: number, private readonly max = CACHE_MAX_ENTRIES, private readonly now: () => number = Date.now) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.expires <= this.now()) { this.map.delete(key); this.misses++; return undefined; }
    this.hits++;
    return e.value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

const clone = (r: ToolResult): ToolResult => structuredClone(r);

/**
 * Read-through TTL cache for catalogue reads (1.5.0): searches (default 8 h) and product details with
 * unit prices and promotions (default 6 h). Only successful results are cached. Cart reads, previews and
 * cart writes never pass through here, so preview and apply always check the live cart and prices.
 */
export class CachedCatalog implements CatalogReader {
  readonly searches: TtlCache<ToolResult>;
  readonly products: TtlCache<ToolResult>;
  constructor(private readonly inner: CatalogReader, opts: { searchTtlMs?: number; productTtlMs?: number; max?: number; now?: () => number; onHit?: (tool: string) => void } = {}) {
    this.searches = new TtlCache(opts.searchTtlMs ?? SEARCH_TTL_MS, opts.max, opts.now);
    this.products = new TtlCache(opts.productTtlMs ?? PRODUCT_TTL_MS, opts.max, opts.now);
    this.onHit = opts.onHit;
  }
  private readonly onHit?: (tool: string) => void;

  async searchProducts(args: { query: string; limit?: number; favoritesFirst?: boolean }): Promise<ToolResult> {
    const key = JSON.stringify([args.query.trim().toLowerCase(), args.limit ?? null, args.favoritesFirst ?? null]);
    const hit = this.searches.get(key);
    if (hit) { this.onHit?.('search_products'); return clone(hit); }
    const res = await this.inner.searchProducts(args);
    if (res.status === 'success') this.searches.set(key, clone(res));
    return res;
  }

  async getProduct(productId: string): Promise<ToolResult> {
    const hit = this.products.get(productId);
    if (hit) { this.onHit?.('get_product'); return clone(hit); }
    const res = await this.inner.getProduct(productId);
    if (res.status === 'success') this.products.set(productId, clone(res));
    return res;
  }

  // Habits have their own daily cache; favourites are cached by the MCP.
  listFrequentlyBought(args?: { orderLimit?: number; limit?: number }) { return this.inner.listFrequentlyBought(args); }
  listFavorites(refresh?: boolean) { return this.inner.listFavorites(refresh); }

  /** Drop everything (account changed or a new sign-in). */
  clear(): void { this.searches.clear(); this.products.clear(); }

  stats() {
    return {
      search: { entries: this.searches.size, hits: this.searches.hits, misses: this.searches.misses },
      product: { entries: this.products.size, hits: this.products.hits, misses: this.products.misses },
    };
  }
}
