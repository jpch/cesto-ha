import { itemKey, tokens, type CatalogReader, type Product, type Qty } from './catalog.js';
import type { Habits, PreferenceStore } from './habits.js';
import type { LinkedProduct } from './lists.js';
import { thumbnailUrl } from './thumbnails.js';
import { productOf, productsOf } from './mcp/upstream.js';

export interface MatchItem { id: number; name: string; quantity: number | null; unit: string | null; product?: LinkedProduct | null }
export type Reason = 'linked' | 'preference' | 'frequent' | 'favorite' | 'search';
export interface Option {
  product_id: string; name: string; package_text: string | null; price: Product['price'] | null;
  availability: string; image_url: string | null; thumbnail_url: string | null; promotions: Product['promotions']; reason: Reason;
  /** 1.6.0+: price per kg or l when the shop shows one. */
  unit_price?: Product['unitPrice'] | null;
}
export interface PromoSuggestion { kind: 'multi_buy' | 'nth_unit_discount'; label: string; suggested_quantity: number }
export interface Line {
  item_id: number;
  item_name: string;
  item_key: string;
  requested: { quantity: number | null; unit: string | null };
  /** Chosen product, or null while the user still has to pick. */
  selected: Option | null;
  /** 2-4 candidates for generic items; out-of-stock alternatives (max 3) when the usual product is unavailable. */
  options: Option[];
  needs_choice: boolean;
  out_of_stock: boolean;
  /** The usual product when it is out of stock (options then hold up to 3 alternatives). */
  unavailable: Option | null;
  /** Cart quantity in the product's sale unit. */
  quantity: number;
  quantity_basis: 'units' | 'packs' | 'weighed_pieces' | 'weight' | 'default';
  promo: PromoSuggestion | null;
  skipped: boolean;
  error: string | null;
}

const toOption = (p: Product, reason: Reason): Option => ({
  product_id: p.productId, name: p.name, package_text: p.packageText ?? null, price: p.price ?? null,
  availability: p.availability ?? 'unknown', image_url: p.imageUrl ?? null, thumbnail_url: thumbnailUrl(p.imageUrl), promotions: p.promotions ?? [], reason,
  unit_price: p.unitPrice ?? null,
});

const toBase = (q: Qty | { value: number; unit: string }): { value: number; dim: 'mass' | 'volume' | 'count' } | null => {
  switch (q.unit) {
    case 'kg': return { value: q.value * 1000, dim: 'mass' };
    case 'g': return { value: q.value, dim: 'mass' };
    case 'l': return { value: q.value * 1000, dim: 'volume' };
    case 'ml': return { value: q.value, dim: 'volume' };
    case 'un': return { value: q.value, dim: 'count' };
    default: return null;
  }
};

/** Converts the list quantity into the cart quantity for one product (sale unit). */
export function cartQuantity(item: Pick<MatchItem, 'quantity' | 'unit'>, product: Product): { quantity: number; basis: Line['quantity_basis'] } {
  const q = item.quantity && item.quantity > 0 ? item.quantity : null;
  if (!q) return { quantity: 1, basis: 'default' };
  if (!item.unit || item.unit === 'un') return { quantity: Math.max(1, Math.round(q)), basis: 'units' };
  const wanted = toBase({ value: q, unit: item.unit });
  if (!wanted) return { quantity: 1, basis: 'default' };
  const rules = product.saleRules?.status === 'available' ? product.saleRules.rules : undefined;
  if (wanted.dim === 'mass' && rules?.storefrontUnit === 'kg') {
    const kg = wanted.value / 1000;
    if (rules.saleUnit === 'un' && rules.storefrontUnitsPerSaleUnit > 0) {
      const min = rules.minimum?.value ?? 1;
      return { quantity: Math.max(min, Math.round(kg / rules.storefrontUnitsPerSaleUnit)), basis: 'weighed_pieces' };
    }
    if (rules.saleUnit === 'kg') {
      const step = rules.step?.value ?? 0.001;
      const value = Math.max(rules.minimum?.value ?? step, Math.round(kg / step) * step);
      return { quantity: Number(value.toFixed(3)), basis: 'weight' };
    }
  }
  const net = product.package?.net ? toBase(product.package.net) : null;
  if (net && net.dim === wanted.dim && net.value > 0) return { quantity: Math.max(1, Math.ceil(wanted.value / net.value - 1e-9)), basis: 'packs' };
  return { quantity: 1, basis: 'default' };
}

/** Promotion hint: buying a bit more unlocks a multi-buy or an nth-unit discount. */
export function promoSuggestion(product: Product, quantity: number): PromoSuggestion | null {
  for (const p of product.promotions ?? []) {
    if (p.kind === 'multi_buy' && p.bundle && p.bundle.quantity > quantity && p.bundle.quantity - quantity <= 2)
      return { kind: 'multi_buy', label: p.label, suggested_quantity: p.bundle.quantity };
    if (p.kind === 'nth_unit_discount' && p.nthUnit && p.nthUnit > quantity && p.nthUnit - quantity <= 2)
      return { kind: 'nth_unit_discount', label: p.label, suggested_quantity: p.nthUnit };
  }
  return null;
}

const overlap = (a: string[], b: string[]) => a.filter(w => b.includes(w)).length;

/**
 * Item -> ranked candidates. Order: learned household preference > frequently bought > favourite > search.
 * Generic items without history get 2-4 options and need a choice; unavailable products get up to 3 alternatives.
 */
export class Matcher {
  constructor(private readonly catalog: CatalogReader, private readonly prefs: PreferenceStore) {}

  async match(item: MatchItem, habits: Habits): Promise<Line> {
    const key = itemKey(item.name);
    const words = tokens(item.name);
    const line: Line = {
      item_id: item.id, item_name: item.name, item_key: key, requested: { quantity: item.quantity, unit: item.unit },
      selected: null, options: [], needs_choice: true, out_of_stock: false, unavailable: null, quantity: 1, quantity_basis: 'default', promo: null, skipped: false, error: null,
    };

    // 0. Product linked to the item by the user (decision 58): used as is, no re-matching.
    if (item.product) return this.linked(line, item, item.product);

    const search = await this.catalog.searchProducts({ query: item.name, limit: 10, favoritesFirst: true });
    if (search.status === 'error') { line.error = search.error?.code ?? 'search_failed'; }
    const found = productsOf(search);
    const frequentIds = new Map(habits.frequent.filter(f => f.productId).map((f, i) => [f.productId!, i]));
    const favoriteIds = new Set(habits.favorites.map(f => f.productId));

    const reasonOf = (p: Product): Reason => (frequentIds.has(p.productId) ? 'frequent' : favoriteIds.has(p.productId) || p.favorite ? 'favorite' : 'search');
    const score = (p: Product, index: number) => {
      const rel = overlap(words, tokens(p.name));
      if (rel === 0) return -1;
      const freq = frequentIds.has(p.productId) ? 100 - frequentIds.get(p.productId)! : 0;
      const fav = favoriteIds.has(p.productId) || p.favorite ? 30 : 0;
      return freq + fav + rel * 5 - index * 0.5;
    };
    const ranked = found.map((p, i) => ({ p, s: score(p, i) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s).map(x => x.p);
    const available = (p: Product) => p.availability !== 'unavailable';

    // 1. Learned preference.
    const pref = this.prefs.get(key);
    let chosen: Product | undefined;
    let reason: Reason = 'search';
    if (pref) {
      const res = await this.catalog.getProduct(pref.product_id);
      { const got = productOf(res); if (got) { chosen = got; reason = 'preference'; } }
    }
    // 2-3. Frequent or favourite product among the matches.
    if (!chosen) {
      const habitual = ranked.find(p => reasonOf(p) !== 'search');
      if (habitual) { chosen = habitual; reason = reasonOf(habitual); }
    }

    if (chosen) {
      if (chosen.availability === 'unavailable') {
        line.out_of_stock = true;
        line.options = ranked.filter(p => p.productId !== chosen!.productId && available(p)).slice(0, 3).map(p => toOption(p, reasonOf(p)));
        line.unavailable = toOption(chosen, reason);
        return line;
      }
      line.selected = toOption(chosen, reason);
      line.options = ranked.filter(p => p.productId !== chosen!.productId && available(p)).slice(0, 3).map(p => toOption(p, reasonOf(p)));
      line.needs_choice = false;
      await this.finishQuantity(line, chosen, item, pref?.quantity ?? null);
      return line;
    }

    // 4. Generic item: offer 2-4 options, preselect the most relevant one as a suggestion.
    const candidates = ranked.filter(available).slice(0, 4);
    line.options = candidates.map(p => toOption(p, 'search'));
    if (candidates.length === 1) {
      line.selected = line.options[0]!;
      line.needs_choice = false;
      await this.finishQuantity(line, candidates[0]!, item, null);
    } else if (candidates.length === 0) {
      line.error = line.error ?? 'no_match';
    }
    return line;
  }

  private async linked(line: Line, item: MatchItem, link: LinkedProduct): Promise<Line> {
    const res = await this.catalog.getProduct(link.product_id);
    const fresh = productOf(res);
    // Keep the linked id even if the catalogue answers with something else or not at all.
    const product: Product = fresh && String(fresh.productId) === link.product_id ? fresh : {
      productId: link.product_id, name: link.name, packageText: link.package_text, price: (link.price as Product['price']) ?? null,
      imageUrl: link.image_url, availability: 'unknown', promotions: [],
    };
    if (!product.imageUrl && link.image_url) product.imageUrl = link.image_url;
    if (product.availability === 'unavailable') {
      line.out_of_stock = true;
      line.unavailable = toOption(product, 'linked');
      const search = await this.catalog.searchProducts({ query: item.name, limit: 10, favoritesFirst: true });
      const words = tokens(item.name);
      line.options = productsOf(search)
        .filter(p => p.productId && p.productId !== link.product_id && p.availability !== 'unavailable' && overlap(words, tokens(p.name)) > 0)
        .slice(0, 3).map(p => toOption(p, 'search'));
      return line;
    }
    line.selected = toOption(product, 'linked');
    line.needs_choice = false;
    await this.finishQuantity(line, product, item, null);
    return line;
  }

  /** Quantity for the chosen product (reads sale rules for weighed products) plus promo hint. */
  async finishQuantity(line: Line, product: Product, item: Pick<MatchItem, 'quantity' | 'unit'>, preferredQuantity: number | null): Promise<void> {
    let p = product;
    const weighed = (item.unit === 'kg' || item.unit === 'g') && p.price?.per === 'kg' && !p.saleRules;
    if (weighed) {
      const res = await this.catalog.getProduct(p.productId);
      { const got = productOf(res); if (got) p = { ...p, ...got }; }
    }
    const q = item.quantity == null && preferredQuantity ? { quantity: preferredQuantity, basis: 'units' as const } : cartQuantity(item, p);
    line.quantity = q.quantity;
    line.quantity_basis = q.basis;
    line.promo = promoSuggestion(p, q.quantity);
  }
}
