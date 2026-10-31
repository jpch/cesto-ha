import type { CatalogReader, Product, Promotion } from './catalog.js';
import { thumbnailUrl } from './thumbnails.js';
import type { AiClient } from './ai.js';
import type { Item } from './lists.js';
import { productsOf } from './mcp/upstream.js';

export interface PromoProduct { product_id: string; name: string; package_text: string | null; price: Product['price'] | null; image_url: string | null; thumbnail_url: string | null; promotions: Promotion[] }
export interface PromoSuggestion { item_id: number; item_name: string; query: string; product: PromoProduct; reason: string | null }
export interface PromotionsResult {
  source: 'ai' | 'search';
  provider: string;
  generated_at: string;
  suggestions: PromoSuggestion[];
  /** Message key when the AI provider was configured but failed and the search fallback was used. */
  ai_error: string | null;
}

const MAX_ITEMS = 20;
const PER_ITEM = 3;
const MAX_AI = 15;

const toPromo = (p: Product): PromoProduct => ({
  product_id: p.productId, name: p.name, package_text: p.packageText ?? null, price: p.price ?? null, image_url: p.imageUrl ?? null, thumbnail_url: thumbnailUrl(p.imageUrl), promotions: p.promotions ?? [],
});

/**
 * Promotion suggestions for the pending list items, shown before the cart preview. Read-only: it only
 * calls `search_products` (category, or the item name when it has none) and keeps products on promotion.
 * When an AI provider is configured it picks the most relevant of those candidates and explains why;
 * if it is not configured, or fails, the plain search result is returned. Never touches the cart.
 */
export class PromotionService {
  constructor(private readonly catalog: CatalogReader, private readonly ai: AiClient | null, private readonly language: string) {}

  async suggest(items: Item[]): Promise<PromotionsResult> {
    const pending = items.filter(i => !i.deleted && i.state === 'pending').slice(0, MAX_ITEMS);
    const seen = new Set<string>();
    const candidates: PromoSuggestion[] = [];
    const byQuery = new Map<string, Product[]>();
    for (const item of pending) {
      const query = (item.category?.trim() || item.name).slice(0, 80);
      let found = byQuery.get(query.toLowerCase());
      if (!found) {
        const res = await this.catalog.searchProducts({ query, limit: 20 });
        found = productsOf(res).filter(p => (p.promotions?.length ?? 0) > 0 && p.availability !== 'unavailable');
        byQuery.set(query.toLowerCase(), found);
      }
      let n = 0;
      for (const p of found) {
        if (n >= PER_ITEM || seen.has(p.productId)) continue;
        seen.add(p.productId); n++;
        candidates.push({ item_id: item.id, item_name: item.name, query, product: toPromo(p), reason: null });
      }
    }
    const base = { provider: this.ai?.name ?? 'none', generated_at: new Date().toISOString() };
    if (!this.ai || !candidates.length) return { ...base, source: 'search', suggestions: candidates, ai_error: null };
    try {
      return { ...base, source: 'ai', suggestions: await this.rank(candidates), ai_error: null };
    } catch {
      return { ...base, source: 'search', suggestions: candidates, ai_error: 'error.ai_failed' };
    }
  }

  /** The AI may only choose among the searched candidates; unknown ids are dropped. */
  private async rank(candidates: PromoSuggestion[]): Promise<PromoSuggestion[]> {
    const input = candidates.map(c => ({ item_id: c.item_id, item: c.item_name, product_id: c.product.product_id, product: c.product.name,
      package: c.product.package_text, price_minor: c.product.price?.amount.minorUnits ?? null, promotions: c.product.promotions.map(p => p.label) }));
    const system = `You help a household choose supermarket promotions for their shopping list. Only pick from the candidates given. ` +
      `Prefer promotions that fit the list item and save money. Reply with JSON only: {"suggestions":[{"item_id":number,"product_id":string,"reason":string}]}. ` +
      `At most ${MAX_AI} suggestions. Write each reason in one short sentence in the language "${this.language}".`;
    const reply = await this.ai!.completeJson(system, JSON.stringify({ candidates: input }));
    const list = (reply as { suggestions?: unknown })?.suggestions;
    if (!Array.isArray(list)) throw new Error('invalid AI reply');
    const out: PromoSuggestion[] = [];
    for (const s of list) {
      const c = candidates.find(x => x.product.product_id === String((s as { product_id?: unknown }).product_id) && x.item_id === Number((s as { item_id?: unknown }).item_id));
      if (!c || out.includes(c)) continue;
      const reason = (s as { reason?: unknown }).reason;
      out.push({ ...c, reason: typeof reason === 'string' ? reason.slice(0, 300) : null });
      if (out.length >= MAX_AI) break;
    }
    if (!out.length) throw new Error('AI chose nothing valid');
    return out;
  }
}
