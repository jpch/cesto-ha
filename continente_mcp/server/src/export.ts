import type { DatabaseSync } from 'node:sqlite';

/** Household data as JSON: lists with items, purchase runs and shared preferences. No tokens or credentials. */
export function exportData(db: DatabaseSync, version: string) {
  const lists = db.prepare('SELECT * FROM lists ORDER BY id').all() as { id: number }[];
  const items = db.prepare('SELECT id, client_id, name, quantity, unit, note, category, added_by, state, created_at, updated_at FROM items WHERE list_id = ? AND deleted = 0 ORDER BY id');
  const runs = db.prepare('SELECT * FROM history_runs ORDER BY id').all() as { id: number }[];
  const runItems = db.prepare('SELECT item_name, product_id, quantity, outcome FROM history_items WHERE run_id = ? ORDER BY id');
  return {
    format: 'continente-mcp-export',
    format_version: 1,
    app_version: version,
    exported_at: new Date().toISOString(),
    lists: lists.map(l => ({ ...l, items: items.all(l.id) })),
    runs: runs.map(r => ({ ...r, items: runItems.all(r.id) })),
    preferences: db.prepare('SELECT item_key, product_id, quantity, chosen_by, updated_at FROM preferences ORDER BY item_key').all(),
  };
}
