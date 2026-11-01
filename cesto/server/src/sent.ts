import type { DatabaseSync } from 'node:sqlite';

/** One product the household sent to the cart before (1.9.0, "Produtos já enviados"). */
export interface SentProduct {
  /** Stable group key: `p:<product_id>` or `n:<lower-cased item name>` for items sent without a product. */
  key: string;
  item_name: string;
  product_id: string | null;
  product_name: string | null;
  /** Number of cart sends (runs) that included it; each send counts once. */
  sends: number;
  last_sent_at: string;
}

/** Real sends only: no test-mode runs, and lines the cart did not take (`not_applied`), simulated or never sent. */
const SENT = `r.test_mode = 0 AND h.outcome NOT IN ('not_applied', 'simulated', 'pending')`;

export function sentProducts(db: DatabaseSync, limit = 200): SentProduct[] {
  const rows = db.prepare(`
    SELECT CASE WHEN h.product_id IS NOT NULL THEN 'p:' || h.product_id ELSE 'n:' || lower(trim(h.item_name)) END AS key,
           h.item_name, h.product_id, h.product_name, h.run_id, r.created_at
    FROM history_items h JOIN history_runs r ON r.id = h.run_id
    WHERE ${SENT} AND trim(h.item_name) <> ''
    ORDER BY r.created_at DESC, h.id DESC`).all() as { key: string; item_name: string; product_id: string | null; product_name: string | null; run_id: number; created_at: string }[];
  const groups = new Map<string, SentProduct & { runs: Set<number> }>();
  for (const row of rows) {
    let g = groups.get(row.key);
    if (!g) {
      g = { key: row.key, item_name: row.item_name.trim(), product_id: row.product_id, product_name: row.product_name, sends: 0, last_sent_at: row.created_at, runs: new Set() };
      groups.set(row.key, g);
    }
    if (!g.product_name && row.product_name) g.product_name = row.product_name;
    g.runs.add(row.run_id);
  }
  return [...groups.values()]
    .map(({ runs, ...g }) => ({ ...g, sends: runs.size }))
    .sort((a, b) => b.sends - a.sends || b.last_sent_at.localeCompare(a.last_sent_at) || a.item_name.localeCompare(b.item_name))
    .slice(0, limit);
}
