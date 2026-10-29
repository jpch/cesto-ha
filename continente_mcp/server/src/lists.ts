import type { DatabaseSync } from 'node:sqlite';
import type { Unit } from './parser.js';

export type ItemState = 'pending' | 'in_cart' | 'not_bought';
export interface Item {
  id: number; list_id: number; client_id: string | null; name: string; quantity: number | null; unit: Unit | null;
  note: string | null; category: string | null; added_by: string; state: ItemState; deleted: boolean;
  version: number; created_at: string; updated_at: string;
}
export interface List { id: number; name: string; status: 'active' | 'archived'; created_at: string; updated_at: string }
export interface ItemInput { name?: unknown; quantity?: unknown; unit?: unknown; note?: unknown; state?: unknown; category?: unknown; client_id?: unknown; updated_at?: unknown }

export class ValidationError extends Error { constructor(public readonly key: string) { super(key); } }

const UNITS = ['un', 'kg', 'g', 'l', 'ml'];
const STATES = ['pending', 'in_cart', 'not_bought'];
const COLS = 'id, list_id, client_id, name, quantity, unit, note, category, added_by, state, deleted, version, created_at, updated_at';

const toItem = (row: Record<string, unknown>): Item => ({ ...(row as unknown as Item), deleted: row.deleted === 1 });

/** Shared household list with a global change sequence for delta sync and last-write-wins edits. */
export class ListService {
  constructor(private readonly db: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {}

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
      'INSERT INTO items (list_id, client_id, name, quantity, unit, note, category, added_by, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(list.id, clientId, fields.name as string, (fields.quantity ?? null) as number | null, (fields.unit ?? null) as string | null,
      (fields.note ?? null) as string | null, (fields.category ?? null) as string | null, addedBy, (fields.state ?? 'pending') as string,
      this.nextVersion(), t, t).lastInsertRowid);
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
    return this.items(listId).map(i => this.add({ name: i.name, quantity: i.quantity, unit: i.unit, note: i.note, category: i.category }, addedBy).item);
  }
}
