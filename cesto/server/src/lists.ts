import type { DatabaseSync } from 'node:sqlite';
import type { Unit } from './parser.js';

/**
 * Continente product the user picked for an item (photo search, decision 58). The basket uses it as is,
 * without matching again. A snapshot of the attributes shown when it was chosen.
 */
export interface LinkedProduct {
  product_id: string; name: string; package_text: string | null; price: unknown; unit_price: unknown;
  image_url: string | null; promotions: { kind: string; label: string }[]; barcode: string | null;
}
export type ItemState = 'pending' | 'in_cart' | 'not_bought';
export interface Item {
  id: number; list_id: number; client_id: string | null; name: string; quantity: number | null; unit: Unit | null;
  note: string | null; category: string | null; added_by: string; state: ItemState; deleted: boolean;
  version: number; created_at: string; updated_at: string;
  product: LinkedProduct | null;
  /** Preferred supermarket (connector id); null means the default connector (decision 63). */
  store: string | null;
}
export interface List { id: number; name: string; status: 'active' | 'archived'; created_at: string; updated_at: string }
export interface ItemInput { name?: unknown; quantity?: unknown; unit?: unknown; note?: unknown; state?: unknown; category?: unknown; client_id?: unknown; updated_at?: unknown; product?: unknown; store?: unknown }

export class ValidationError extends Error { constructor(public readonly key: string) { super(key); } }

const UNITS = ['un', 'kg', 'g', 'l', 'ml'];
const STATES = ['pending', 'in_cart', 'not_bought'];
const COLS = 'id, list_id, client_id, name, quantity, unit, note, category, added_by, state, deleted, version, created_at, updated_at, product_json, store';

const toItem = (row: Record<string, unknown>): Item => {
  const { product_json, ...rest } = row;
  let product: LinkedProduct | null = null;
  if (typeof product_json === 'string') { try { product = JSON.parse(product_json) as LinkedProduct; } catch { product = null; } }
  return { ...(rest as unknown as Item), deleted: row.deleted === 1, product };
};

/** Key for learned supermarket choices: case- and accent-insensitive item name. */
export const storeKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const plainObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Validates and trims a linked product; null unlinks. */
export function linkedProduct(input: unknown): LinkedProduct | null {
  if (input === null) return null;
  const o = plainObject(input) as Record<string, unknown> | null;
  if (!o || typeof o.product_id !== 'string' || !/^\d{1,20}$/.test(o.product_id) || !str(o.name, 300)) throw new ValidationError('error.invalid_product');
  const promotions = Array.isArray(o.promotions)
    ? o.promotions.slice(0, 5).map(p => plainObject(p) as Record<string, unknown> | null).filter(p => p && typeof p.label === 'string')
      .map(p => ({ kind: String(p!.kind ?? 'other').slice(0, 40), label: String(p!.label).slice(0, 120) }))
    : [];
  const barcode = typeof o.barcode === 'string' && /^\d{6,14}$/.test(o.barcode) ? o.barcode : null;
  return {
    product_id: o.product_id, name: str(o.name, 300)!, package_text: str(o.package_text, 120), price: plainObject(o.price), unit_price: plainObject(o.unit_price),
    image_url: typeof o.image_url === 'string' && /^https:\/\//.test(o.image_url) ? o.image_url.slice(0, 500) : null, promotions, barcode,
  };
}

/** Shared household list with a global change sequence for delta sync and last-write-wins edits. */
export class ListService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    /** Enabled connector ids; an item's store must be one of them. */
    private readonly stores: readonly string[] = ['continente'],
  ) {}

  /** Learned preferred supermarket for an item name (decision 63). */
  learnedStore(name: string): string | null {
    const row = this.db.prepare('SELECT store FROM store_preferences WHERE item_key = ?').get(storeKey(name)) as { store: string } | undefined;
    return row && this.stores.includes(row.store) ? row.store : null;
  }

  /** Remembers the user's supermarket choice for this item name. */
  learnStore(name: string, store: string): void {
    this.db.prepare('INSERT INTO store_preferences (item_key, store, updated_at) VALUES (?, ?, ?) ON CONFLICT(item_key) DO UPDATE SET store = excluded.store, updated_at = excluded.updated_at')
      .run(storeKey(name), store, this.now());
  }

  private nextVersion(): number {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('seq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: string }).value);
  }

  currentVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** The single active household list (decision 34), created on demand. */
  current(): List {
    const row = this.db.prepare("SELECT * FROM lists WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as List | undefined;
    if (row) return row;
    const t = this.now();
    const id = Number(this.db.prepare("INSERT INTO lists (name, status, created_at, updated_at) VALUES ('household', 'active', ?, ?)").run(t, t).lastInsertRowid);
    return this.db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as unknown as List;
  }

  items(listId: number, sinceVersion?: number): Item[] {
    const rows = sinceVersion === undefined
      ? this.db.prepare(`SELECT ${COLS} FROM items WHERE list_id = ? AND deleted = 0 ORDER BY id`).all(listId)
      : this.db.prepare(`SELECT ${COLS} FROM items WHERE list_id = ? AND version > ? ORDER BY version`).all(listId, sinceVersion);
    return rows.map(r => toItem(r as Record<string, unknown>));
  }

  get(id: number): Item | undefined {
    const row = this.db.prepare(`SELECT ${COLS} FROM items WHERE id = ?`).get(id);
    return row ? toItem(row as Record<string, unknown>) : undefined;
  }

  private validate(input: ItemInput, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (creating || input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new ValidationError('error.invalid_item_name');
      out.name = input.name.trim();
    }
    if (input.quantity !== undefined) {
      if (input.quantity !== null && (typeof input.quantity !== 'number' || !(input.quantity > 0) || input.quantity > 10000)) throw new ValidationError('error.invalid_quantity');
      out.quantity = input.quantity;
    }
    if (input.unit !== undefined) {
      if (input.unit !== null && !UNITS.includes(input.unit as string)) throw new ValidationError('error.invalid_unit');
      out.unit = input.unit;
    }
    for (const key of ['note', 'category'] as const) {
      if (input[key] !== undefined) {
        if (input[key] !== null && (typeof input[key] !== 'string' || (input[key] as string).length > 500)) throw new ValidationError(`error.invalid_${key}`);
        out[key] = input[key];
      }
    }
    if (input.product !== undefined) {
      const product = linkedProduct(input.product);
      out.product_id = product?.product_id ?? null;
      out.product_json = product ? JSON.stringify(product) : null;
    }
    if (input.store !== undefined) {
      if (input.store !== null && (typeof input.store !== 'string' || !this.stores.includes(input.store))) throw new ValidationError('error.invalid_store');
      out.store = input.store;
    }
    if (input.state !== undefined) {
      if (!STATES.includes(input.state as string)) throw new ValidationError('error.invalid_state');
      out.state = input.state;
    }
    return out;
  }

  /** Idempotent on client_id, so a phone can safely resend its offline queue. */
  add(input: ItemInput, addedBy: string): { item: Item; created: boolean } {
    const fields = this.validate(input, true);
    const list = this.current();
    const clientId = typeof input.client_id === 'string' && input.client_id ? input.client_id.slice(0, 100) : null;
    if (clientId) {
      const existing = this.db.prepare(`SELECT ${COLS} FROM items WHERE list_id = ? AND client_id = ?`).get(list.id, clientId);
      if (existing) return { item: toItem(existing as Record<string, unknown>), created: false };
    }
    const t = this.now();
    const id = Number(this.db.prepare(
      'INSERT INTO items (list_id, client_id, name, quantity, unit, note, category, added_by, state, version, created_at, updated_at, product_id, product_json, store) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(list.id, clientId, fields.name as string, (fields.quantity ?? null) as number | null, (fields.unit ?? null) as string | null,
      (fields.note ?? null) as string | null, (fields.category ?? null) as string | null, addedBy, (fields.state ?? 'pending') as string,
      this.nextVersion(), t, t, (fields.product_id ?? null) as string | null, (fields.product_json ?? null) as string | null,
      (fields.store !== undefined ? fields.store : this.learnedStore(fields.name as string)) as string | null).lastInsertRowid);
    if (typeof fields.store === 'string') this.learnStore(fields.name as string, fields.store);
    return { item: this.get(id)!, created: true };
  }

  /**
   * Last write wins: an edit carrying an `updated_at` older than the stored one is ignored and the
   * current item is returned with applied=false. Without `updated_at` the server time is used.
   */
  update(id: number, input: ItemInput): { item: Item; applied: boolean } | undefined {
    const item = this.get(id);
    if (!item || item.deleted) return undefined;
    const fields = this.validate(input, false);
    const editedAt = this.editTime(input.updated_at);
    if (editedAt < item.updated_at) return { item, applied: false };
    const sets = Object.keys(fields).map(k => `${k} = ?`);
    this.db.prepare(`UPDATE items SET ${[...sets, 'version = ?', 'updated_at = ?'].join(', ')} WHERE id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), this.nextVersion(), editedAt, id);
    if (typeof fields.store === 'string') this.learnStore((fields.name as string | undefined) ?? item.name, fields.store);
    return { item: this.get(id)!, applied: true };
  }

  remove(id: number, updatedAt?: unknown): { applied: boolean } | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    if (item.deleted) return { applied: true };
    const editedAt = this.editTime(updatedAt);
    if (editedAt < item.updated_at) return { applied: false };
    this.db.prepare('UPDATE items SET deleted = 1, version = ?, updated_at = ? WHERE id = ?').run(this.nextVersion(), editedAt, id);
    return { applied: true };
  }

  private editTime(value: unknown): string {
    if (value === undefined || value === null) return this.now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ValidationError('error.invalid_updated_at');
    // Clamp client clocks running ahead of the server so one phone cannot lock an item.
    const t = new Date(value).toISOString();
    return t > this.now() ? this.now() : t;
  }

  /** Clears items in the cart (decision 31) or all items of the current list. */
  clear(scope: 'in_cart' | 'all'): number {
    const list = this.current();
    const ids = (this.db.prepare(`SELECT id FROM items WHERE list_id = ? AND deleted = 0 ${scope === 'in_cart' ? "AND state = 'in_cart'" : ''}`).all(list.id) as { id: number }[]);
    for (const { id } of ids) this.db.prepare('UPDATE items SET deleted = 1, version = ?, updated_at = ? WHERE id = ?').run(this.nextVersion(), this.now(), id);
    return ids.length;
  }

  /** Archives the current list (kept in history) and starts a new empty one. */
  startNew(): List {
    const t = this.now();
    const old = this.current();
    this.db.prepare("UPDATE lists SET status = 'archived', updated_at = ? WHERE id = ?").run(t, old.id);
    this.nextVersion();
    return this.current();
  }

  history(): (List & { item_count: number })[] {
    return this.db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.deleted = 0) AS item_count
      FROM lists l WHERE status = 'archived' ORDER BY l.id DESC`).all() as unknown as (List & { item_count: number })[];
  }

  /** Copies an archived list's items into the current list as pending; the cart is only reached via preview. */
  repeat(listId: number, addedBy: string): Item[] | undefined {
    const list = this.db.prepare("SELECT * FROM lists WHERE id = ? AND status = 'archived'").get(listId);
    if (!list) return undefined;
    return this.items(listId).map(i => this.add({ name: i.name, quantity: i.quantity, unit: i.unit, note: i.note, category: i.category, product: i.product ?? undefined, store: i.store && this.stores.includes(i.store) ? i.store : null }, addedBy).item);
  }
}
