import type { RunJob } from './queue.js';
import type { CatalogReader, Product, Promotion } from './catalog.js';
import { thumbnailUrl } from './thumbnails.js';
import type { AiClient } from './ai.js';
import type { Item } from './lists.js';
import { productOf, productsOf } from './mcp/upstream.js';

import { randomUUID } from 'node:crypto';

export interface PromoProduct {
  product_id: string; name: string; package_text: string | null; price: Product['price'] | null;
  /** Price per kg or l when the shop shows one (1.4.0+). */
  unit_price: Product['unitPrice'] | null;
  /** Largest percentage discount among the promotions, when known (1.4.0+). */
  discount_percent: number | null;
  image_url: string | null; thumbnail_url: string | null; promotions: Promotion[];
}
export interface PromoSuggestion {
  item_id: number; item_name: string; query: string; product: PromoProduct; reason: string | null;
  /**
   * 1.4.0+: related products (same search, any brand or size, on promotion or not) whose price per kg or l is
   * strictly lower than [product]'s, in the same unit, cheapest per unit first.
   */
  cheaper: PromoProduct[];
}
/** Per-item state of an async search, for the progress screen. */
export interface SearchItemState { item_id: number; item_name: string; status: 'queued' | 'searching' | 'done'; promos: number; cheaper: number }
export interface PromotionSearch {
  search_id: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  done: number; total: number;
  items: SearchItemState[];
  /** Present once the search is done or cancelled (partial results). */
  result: PromotionsResult | null;
  error: { message_key: string } | null;
}
/** The product currently chosen for an item (from a proposal line), used as the unit-price basis. */
export interface SelectedProduct { product_id: string; unit_price?: Product['unitPrice'] | null }
/**
 * 1.6.0+: one entry per searched item. `promotions` and `cheaper` are deduplicated, never contain the selected
 * product, and never share a product. `cheaper` is compared with `basis`: the selected product's price per kg/l,
 * or (no selection known) the first promotion's.
 */
export interface ItemPromotions {
  item_id: number; item_name: string; query: string;
  selected_product_id: string | null;
  basis: { unit_price: NonNullable<Product['unitPrice']>; source: 'selected' | 'promotion' } | null;
  promotions: PromoProduct[];
  cheaper: PromoProduct[];
}
export interface PromotionsResult {
  source: 'ai' | 'search';
  provider: string;
  generated_at: string;
  suggestions: PromoSuggestion[];
  /** 1.6.0+: one entry per searched item (see [ItemPromotions]). Older apps ignore it. */
  items: ItemPromotions[];
  /** Message key when the AI provider was configured but failed and the search fallback was used. */
  ai_error: string | null;
}

const MAX_ITEMS = 20;
const PER_ITEM = 3;
const MAX_AI = 15;

const MAX_CHEAPER = 5;

const discountOf = (p: Product): number | null => {
  const offs = (p.promotions ?? []).map(x => x.percentOff).filter((n): n is number => typeof n === 'number' && n > 0);
  return offs.length ? Math.round(Math.max(...offs)) : null;
};

const toPromo = (p: Product): PromoProduct => ({
  product_id: p.productId, name: p.name, package_text: p.packageText ?? null, price: p.price ?? null, unit_price: p.unitPrice ?? null,
  discount_percent: discountOf(p), image_url: p.imageUrl ?? null, thumbnail_url: thumbnailUrl(p.imageUrl), promotions: p.promotions ?? [],
});

const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The first meaningful word of the search ("leite" in "leite meio-gordo"): a related product must name it. */
export function productType(query: string): string | null {
  return fold(query).split(/[^a-z0-9]+/).find(w => w.length >= 3) ?? null;
}

/**
 * Products cheaper per unit than [promo]: same product type (the search for the item, whose name contains the
 * type word), any brand or size, promoted or not; same unit only (kg with kg, l with l); products without a
 * unit price are left out; strictly lower price per unit; cheapest first.
 */
export function cheaperPerUnit(promo: Pick<Product, 'productId' | 'unitPrice'>, related: Product[], query: string): Product[] {
  const base = promo.unitPrice;
  if (!base || base.amount.minorUnits <= 0) return [];
  const type = productType(query);
  return related
    .filter(p => p.productId !== promo.productId && p.availability !== 'unavailable')
    .filter(p => !type || fold(p.name).includes(type))
    .filter(p => p.unitPrice && p.unitPrice.per === base.per && p.unitPrice.amount.currency === base.amount.currency
      && p.unitPrice.amount.minorUnits > 0 && p.unitPrice.amount.minorUnits < base.amount.minorUnits)
    .sort((a, b) => a.unitPrice!.amount.minorUnits - b.unitPrice!.amount.minorUnits)
    .slice(0, MAX_CHEAPER);
}

/**
 * Promotion suggestions for the pending list items, shown before the cart preview. Read-only: it only
 * calls `search_products` (category, or the item name when it has none) and keeps products on promotion.
 * When an AI provider is configured it picks the most relevant of those candidates and explains why;
 * if it is not configured, or fails, the plain search result is returned. Never touches the cart.
 */
export class PromotionService {
  constructor(private readonly catalog: CatalogReader, private readonly ai: AiClient | null, private readonly language: string) {}

  static pending(items: Item[]): Item[] { return items.filter(i => !i.deleted && i.state === 'pending').slice(0, MAX_ITEMS); }

  /**
   * [run] wraps each catalogue search (the MCP queue), so other calls can run between items; [onItem] reports
   * progress; when [cancelled] turns true the search stops after the current item and returns what it has.
   */
  async suggest(items: Item[], hooks: {
    run?: <T>(job: () => Promise<T>) => Promise<T>;
    onItem?: (index: number, state: SearchItemState) => void;
    cancelled?: () => boolean;
    /** Selected product per item id (from the proposal); the unit-price basis for `items[].cheaper`. */
    selected?: Map<number, SelectedProduct>;
  } = {}): Promise<PromotionsResult> {
    const run = hooks.run ?? (<T>(job: () => Promise<T>) => job());
    const pending = PromotionService.pending(items);
    const seen = new Set<string>();
    const candidates: PromoSuggestion[] = [];
    const byQuery = new Map<string, Product[]>();
    const perItem: ItemPromotions[] = [];
    for (const [index, item] of pending.entries()) {
      if (hooks.cancelled?.()) break;
      const state: SearchItemState = { item_id: item.id, item_name: item.name, status: 'searching', promos: 0, cheaper: 0 };
      hooks.onItem?.(index, state);
      const query = (item.category?.trim() || item.name).slice(0, 80);
      let all = byQuery.get(query.toLowerCase());
      if (!all) {
        const res = await run(() => this.catalog.searchProducts({ query, limit: 20 }));
        all = productsOf(res);
        byQuery.set(query.toLowerCase(), all);
      }
      const found = all.filter(p => (p.promotions?.length ?? 0) > 0 && p.availability !== 'unavailable');
      let n = 0;
      for (const p of found) {
        if (n >= PER_ITEM || seen.has(p.productId)) continue;
        seen.add(p.productId); n++;
        const cheaper = cheaperPerUnit(p, all, query).map(toPromo);
        candidates.push({ item_id: item.id, item_name: item.name, query, product: toPromo(p), reason: null, cheaper });
      }
      const entry = await this.itemEntry(item, query, all, found, hooks.selected?.get(item.id) ?? null, run);
      perItem.push(entry);
      state.promos = n;
      state.cheaper = entry.cheaper.length;
      state.status = 'done';
      hooks.onItem?.(index, state);
    }
    const base = { provider: this.ai?.name ?? 'none', generated_at: new Date().toISOString() };
    if (!this.ai || !candidates.length) return { ...base, source: 'search', suggestions: candidates, items: perItem, ai_error: null };
    try {
      return { ...base, source: 'ai', suggestions: await this.rank(candidates), items: perItem, ai_error: null };
    } catch {
      return { ...base, source: 'search', suggestions: candidates, items: perItem, ai_error: 'error.ai_failed' };
    }
  }

  /**
   * One deduplicated block set per item: promotions (max [PER_ITEM], without the selected product) and products
   * cheaper per kg/l than the selected product (or, without a selection, than the first promotion), never
   * repeating a promotion. The selected product's unit price comes from the proposal, the search results, or
   * a (cached) product read.
   */
  private async itemEntry(item: Item, query: string, all: Product[], found: Product[], selected: SelectedProduct | null,
    run: <T>(job: () => Promise<T>) => Promise<T>): Promise<ItemPromotions> {
    const selectedId = selected?.product_id ?? null;
    const promos: Product[] = [];
    for (const p of found) {
      if (promos.length >= PER_ITEM) break;
      if (p.productId === selectedId || promos.some(x => x.productId === p.productId)) continue;
      promos.push(p);
    }
    let basis: ItemPromotions['basis'] = null;
    if (selected) {
      let unit = selected.unit_price ?? all.find(p => p.productId === selected.product_id)?.unitPrice ?? null;
      if (!unit) {
        const res = await run(() => this.catalog.getProduct(selected.product_id)).catch(() => null);
        unit = (res && productOf(res)?.unitPrice) ?? null;
      }
      if (unit) basis = { unit_price: unit, source: 'selected' };
    } else if (promos[0]?.unitPrice) {
      basis = { unit_price: promos[0].unitPrice, source: 'promotion' };
    }
    const exclude = new Set([...(selectedId ? [selectedId] : []), ...promos.map(p => p.productId)]);
    const cheaper = basis
      ? cheaperPerUnit({ productId: selectedId ?? promos[0]?.productId ?? '', unitPrice: basis.unit_price }, all.filter(p => !exclude.has(p.productId)), query)
      : [];
    return { item_id: item.id, item_name: item.name, query, selected_product_id: selectedId, basis, promotions: promos.map(toPromo), cheaper: cheaper.map(toPromo) };
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

/**
 * Async promotion searches (1.4.0): one at a time; a new request while one runs returns it. The phone polls
 * for per-item progress and may cancel, which keeps the partial results. Finished searches expire after 30 min.
 */
export class PromotionSearches {
  private current: PromotionSearch | null = null;
  private cancel = false;

  constructor(private readonly service: PromotionService, run: RunJob) {
    // Promotion searches are background work: preview, apply and line edits run first (1.5.0).
    this.run = <T>(job: () => Promise<T>) => run(job, { priority: 'background', label: 'promotions' });
  }
  private readonly run: <T>(job: () => Promise<T>) => Promise<T>;

  start(items: Item[], selected?: Map<number, SelectedProduct>): PromotionSearch {
    if (this.current?.status === 'running') return this.current;
    const pending = PromotionService.pending(items);
    const search: PromotionSearch = {
      search_id: randomUUID(), status: 'running', done: 0, total: pending.length,
      items: pending.map(i => ({ item_id: i.id, item_name: i.name, status: 'queued', promos: 0, cheaper: 0 })),
      result: null, error: null,
    };
    this.current = search;
    this.cancel = false;
    this.service.suggest(pending, {
      run: this.run,
      selected,
      cancelled: () => this.cancel,
      onItem: (index, state) => { search.items[index] = { ...state }; search.done = search.items.filter(i => i.status === 'done').length; },
    }).then(result => {
      search.result = result;
      search.status = this.cancel ? 'cancelled' : 'done';
    }).catch(() => {
      search.status = 'failed';
      search.error = { message_key: 'error.mcp_unavailable' };
    }).finally(() => {
      setTimeout(() => { if (this.current === search) this.current = null; }, 30 * 60_000).unref?.();
    });
    return search;
  }

  get(id: string): PromotionSearch | undefined { return this.current?.search_id === id ? this.current : undefined; }

  /** Stops after the item being searched; the search then ends as `cancelled` with partial results. */
  stop(id: string): PromotionSearch | undefined {
    const s = this.get(id);
    if (s?.status === 'running') this.cancel = true;
    return s;
  }
}
