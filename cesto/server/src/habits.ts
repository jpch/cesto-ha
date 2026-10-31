import type { DatabaseSync } from 'node:sqlite';
import type { CatalogReader, FrequentProduct, Product } from './catalog.js';

export interface Habits { frequent: FrequentProduct[]; favorites: Product[]; fetched_at: string | null }
const DAY = 24 * 3600_000;

/** Cache of what the household buys (frequent products and favourites), refreshed at most daily. */
export class HabitsService {
  constructor(private readonly db: DatabaseSync, private readonly catalog: CatalogReader, private readonly now = () => Date.now()) {}

  get(): Habits {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'habits'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Habits) : { frequent: [], favorites: [], fetched_at: null };
  }

  async refresh(): Promise<Habits> {
    const [freq, favs] = [await this.catalog.listFrequentlyBought({ orderLimit: 20, limit: 50 }), await this.catalog.listFavorites(true)];
    const previous = this.get();
    const habits: Habits = {
      frequent: freq.status === 'error' ? previous.frequent : ((freq.data?.products as FrequentProduct[] | undefined) ?? []),
      favorites: favs.status === 'error' ? previous.favorites : ((favs.data?.favorites as Product[] | undefined) ?? []),
      fetched_at: new Date(this.now()).toISOString(),
    };
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('habits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(habits));
    return habits;
  }

  async fresh(): Promise<Habits> {
    const h = this.get();
    if (h.fetched_at && this.now() - Date.parse(h.fetched_at) < DAY) return h;
    return this.refresh();
  }
}

export interface Preference { item_key: string; product_id: string; quantity: number | null; chosen_by: string | null; updated_at: string }

/** Household-wide learned choices: item name key -> product. */
export class PreferenceStore {
  constructor(private readonly db: DatabaseSync) {}
  get(key: string): Preference | undefined {
    return this.db.prepare('SELECT item_key, product_id, quantity, chosen_by, updated_at FROM preferences WHERE item_key = ?').get(key) as Preference | undefined;
  }
  list(): Preference[] {
    return this.db.prepare('SELECT item_key, product_id, quantity, chosen_by, updated_at FROM preferences ORDER BY item_key').all() as unknown as Preference[];
  }
  set(key: string, productId: string, quantity: number | null, chosenBy: string | null): Preference {
    this.db.prepare(`INSERT INTO preferences (item_key, product_id, quantity, chosen_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET product_id = excluded.product_id, quantity = excluded.quantity, chosen_by = excluded.chosen_by, updated_at = excluded.updated_at`)
      .run(key, productId, quantity, chosenBy, new Date().toISOString());
    return this.get(key)!;
  }
  remove(key: string): boolean { return this.db.prepare('DELETE FROM preferences WHERE item_key = ?').run(key).changes > 0; }
}
