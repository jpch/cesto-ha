import type { CatalogReader, Product } from './catalog.js';
import { thumbnailUrl } from './thumbnails.js';
import { isNotAuthenticated, productsOf } from './mcp/upstream.js';

export interface SearchCandidate {
  product_id: string; name: string; package_text: string | null; price: Product['price'] | null; unit_price: Product['unitPrice'] | null;
  image_url: string | null; thumbnail_url: string | null; availability: string; promotions: NonNullable<Product['promotions']>;
}
export interface SearchResult { query: string; barcode: string | null; matched_by: 'barcode' | 'name' | null; candidates: SearchCandidate[] }

export class SearchError extends Error { constructor(readonly status: number, readonly key: string) { super(key); } }

const MAX = 8;
const toCandidate = (p: Product): SearchCandidate => ({
  product_id: String(p.productId), name: p.name, package_text: p.packageText ?? null, price: p.price ?? null, unit_price: p.unitPrice ?? null,
  image_url: p.imageUrl ?? null, thumbnail_url: thumbnailUrl(p.imageUrl), availability: p.availability ?? 'unknown', promotions: p.promotions ?? [],
});

/**
 * "Search Continente" after a photo read (decision 57): user-triggered, read-only `search_products`.
 * Tries the barcode first (when given) and falls back to the composed name. Never touches the cart.
 */
export class ProductSearch {
  constructor(private readonly catalog: CatalogReader) {}

  async search(input: { query?: unknown; barcode?: unknown }): Promise<SearchResult> {
    const query = typeof input.query === 'string' ? input.query.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    const barcode = typeof input.barcode === 'string' && /^\d{6,14}$/.test(input.barcode) ? input.barcode : null;
    if (input.barcode != null && input.barcode !== '' && !barcode) throw new SearchError(400, 'error.invalid_barcode');
    if (!query && !barcode) throw new SearchError(400, 'error.invalid_query');
    const run = async (q: string) => {
      const res = await this.catalog.searchProducts({ query: q, limit: MAX, favoritesFirst: true });
      if (res.status === 'error') {
        if (isNotAuthenticated(res)) throw new SearchError(409, 'error.session_expired');
        throw new SearchError(502, 'error.search_failed');
      }
      return productsOf(res);
    };
    if (barcode) {
      const byCode = await run(barcode).catch(e => { if (!query) throw e; return [] as Product[]; });
      if (byCode.length) return { query, barcode, matched_by: 'barcode', candidates: byCode.slice(0, MAX).map(toCandidate) };
    }
    if (!query) return { query, barcode, matched_by: null, candidates: [] };
    const byName = await run(query);
    return { query, barcode, matched_by: byName.length ? 'name' : null, candidates: byName.slice(0, MAX).map(toCandidate) };
  }
}
