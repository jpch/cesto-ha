import type { DatabaseSync } from 'node:sqlite';

export const EXPORT_FORMAT = 'cesto-export';
/** Exports written by the add-on before the rename (Continente MCP 0.x); same shape, fewer item fields. */
const LEGACY_FORMAT = 'continente-mcp-export';

/** Household data as JSON: lists with items, purchase runs and shared preferences. No tokens or credentials. */
export function exportData(db: DatabaseSync, version: string) {
  const lists = db.prepare('SELECT * FROM lists ORDER BY id').all() as { id: number }[];
  const items = db.prepare('SELECT id, client_id, name, quantity, unit, note, category, added_by, state, created_at, updated_at, product_id, product_json, store FROM items WHERE list_id = ? AND deleted = 0 ORDER BY id');
  const runs = db.prepare('SELECT * FROM history_runs ORDER BY id').all() as { id: number }[];
  const runItems = db.prepare('SELECT item_name, product_id, quantity, outcome FROM history_items WHERE run_id = ? ORDER BY id');
  return {
    format: EXPORT_FORMAT,
    format_version: 2,
    app_version: version,
    exported_at: new Date().toISOString(),
    lists: lists.map(l => ({ ...l, items: items.all(l.id) })),
    runs: runs.map(r => ({ ...r, items: runItems.all(r.id) })),
    preferences: db.prepare('SELECT item_key, product_id, quantity, chosen_by, updated_at FROM preferences ORDER BY item_key').all(),
    store_preferences: db.prepare('SELECT item_key, store, updated_at FROM store_preferences ORDER BY item_key').all(),
  };
}

export class ImportError extends Error { constructor(readonly status: number, readonly key: string) { super(key); } }

type Row = Record<string, unknown>;
const arr = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const s = (v: unknown, max = 500): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const UNITS = ['un', 'kg', 'g', 'l', 'ml'] as const;
const STATES = ['pending', 'in_cart', 'not_bought'] as const;
const PRODUCT_ID = /^\d{1,20}$/;

/**
 * One-time import of an export (decision 69): migrates a household from the old add-on slug. Only into an empty
 * database, in one transaction, keeping ids so history and lists stay linked. Tokens and supermarket credentials
 * are never part of an export.
 */
export function importData(db: DatabaseSync, data: unknown, stores: readonly string[]): { lists: number; items: number; runs: number; preferences: number } {
  const d = (data && typeof data === 'object' ? data : {}) as Row;
  if (d.format !== EXPORT_FORMAT && d.format !== LEGACY_FORMAT) throw new ImportError(400, 'error.import_format');
  const used = ['lists', 'items', 'history_runs', 'preferences'].some(t => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c > 0);
  if (used) throw new ImportError(409, 'error.import_not_empty');
  const now = new Date().toISOString();
  const counts = { lists: 0, items: 0, runs: 0, preferences: 0 };
  db.exec('BEGIN');
  try {
    let seq = 0;
    for (const l of arr(d.lists)) {
      const id = n(l.id);
      if (id === null) continue;
      db.prepare('INSERT INTO lists (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, s(l.name, 200) ?? 'household', oneOf(l.status, ['active', 'archived'] as const, 'archived'), s(l.created_at) ?? now, s(l.updated_at) ?? now);
      counts.lists++;
      for (const i of arr(l.items)) {
        const name = s(i.name, 200);
        if (!name) continue;
        const productId = typeof i.product_id === 'string' && PRODUCT_ID.test(i.product_id) ? i.product_id : null;
        const store = typeof i.store === 'string' && stores.includes(i.store) ? i.store : null;
        db.prepare(`INSERT INTO items (list_id, client_id, name, quantity, unit, note, category, added_by, state, version, created_at, updated_at, product_id, product_json, store)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, s(i.client_id, 100), name, n(i.quantity), (UNITS as readonly unknown[]).includes(i.unit) ? (i.unit as string) : null, s(i.note), s(i.category), s(i.added_by, 60) ?? '?',
            oneOf(i.state, STATES, 'pending'), ++seq, s(i.created_at) ?? now, s(i.updated_at) ?? now, productId, productId ? s(i.product_json, 20000) : null, store);
        counts.items++;
      }
    }
    for (const r of arr(d.runs)) {
      const id = n(r.id);
      if (id === null) continue;
      const listId = n(r.list_id);
      const listExists = listId !== null && !!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId);
      db.prepare('INSERT INTO history_runs (id, list_id, test_mode, status, estimated_total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, listExists ? listId : null, r.test_mode ? 1 : 0, s(r.status, 40) ?? 'unknown', n(r.estimated_total_cents), s(r.created_at) ?? now);
      for (const it of arr(r.items))
        db.prepare('INSERT INTO history_items (run_id, item_name, product_id, quantity, outcome) VALUES (?, ?, ?, ?, ?)')
          .run(id, s(it.item_name, 200) ?? '?', typeof it.product_id === 'string' && PRODUCT_ID.test(it.product_id) ? it.product_id : null, n(it.quantity), s(it.outcome, 40) ?? 'unknown');
      counts.runs++;
    }
    for (const p of arr(d.preferences)) {
      const key = s(p.item_key, 200);
      if (!key || typeof p.product_id !== 'string' || !PRODUCT_ID.test(p.product_id)) continue;
      db.prepare('INSERT OR REPLACE INTO preferences (item_key, product_id, quantity, chosen_by, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, p.product_id, n(p.quantity), s(p.chosen_by, 60), s(p.updated_at) ?? now);
      counts.preferences++;
    }
    for (const p of arr(d.store_preferences)) {
      const key = s(p.item_key, 200);
      if (!key || typeof p.store !== 'string' || !stores.includes(p.store)) continue;
      db.prepare('INSERT OR REPLACE INTO store_preferences (item_key, store, updated_at) VALUES (?, ?, ?)').run(key, p.store, s(p.updated_at) ?? now);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(seq));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return counts;
}
