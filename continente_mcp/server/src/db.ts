import { DatabaseSync } from 'node:sqlite';

/** Ordered migrations; index + 1 is the schema version stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    client_id TEXT,
    name TEXT NOT NULL,
    quantity REAL,
    unit TEXT CHECK (unit IS NULL OR unit IN ('un','kg','g','l','ml')),
    note TEXT,
    category TEXT,
    added_by TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_cart','not_bought')),
    thumbnail BLOB,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (list_id, client_id)
  );
  CREATE INDEX items_list_version ON items(list_id, version);
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('phone','app')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE preferences (
    id INTEGER PRIMARY KEY,
    item_key TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL,
    quantity REAL,
    chosen_by TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE history_runs (
    id INTEGER PRIMARY KEY,
    list_id INTEGER REFERENCES lists(id),
    test_mode INTEGER NOT NULL,
    status TEXT NOT NULL,
    estimated_total_cents INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE history_items (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES history_runs(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    product_id TEXT,
    quantity REAL,
    outcome TEXT NOT NULL
  );
  CREATE TABLE product_cache (
    product_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE items ADD COLUMN product_id TEXT;
  ALTER TABLE items ADD COLUMN product_json TEXT;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
