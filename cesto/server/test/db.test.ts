import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDatabase, SCHEMA_VERSION } from '../src/db.js';

describe('database', () => {
  it('creates every table and records the schema version', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining(['lists', 'items', 'tokens', 'preferences', 'history_runs', 'history_items', 'product_cache', 'meta']));
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db); migrate(db);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  it('stores only token hashes', async () => {
    const { TokenStore } = await import('../src/auth.js');
    const db = openDatabase(':memory:');
    const { token } = new TokenStore(db).create('a', 'app');
    const raw = JSON.stringify(db.prepare('SELECT * FROM tokens').all());
    expect(raw).not.toContain(token);
  });
});
