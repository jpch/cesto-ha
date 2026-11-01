import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, REMOTE_ROUTE } from '../src/app.js';
import { migrate, openDatabase } from '../src/db.js';
import { sentProducts } from '../src/sent.js';
import { testConfig } from './helpers.js';

const INGRESS = '172.30.32.2';
const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'alex', 'x-remote-user-display-name': 'Alex' };

function run(db: DatabaseSync, testMode: boolean, at: string, items: [string, string | null, string | null, string][]) {
  const r = db.prepare("INSERT INTO history_runs (list_id, test_mode, status, created_at) VALUES (NULL, ?, 'done', ?)").run(testMode ? 1 : 0, at);
  for (const [name, pid, pname, outcome] of items)
    db.prepare('INSERT INTO history_items (run_id, item_name, product_id, quantity, outcome, product_name) VALUES (?, ?, ?, 1, ?, ?)').run(Number(r.lastInsertRowid), name, pid, outcome, pname);
}

function seed(db: DatabaseSync) {
  run(db, false, '2026-10-01T10:00:00Z', [['leite', '1001', 'Leite Mimosa 1 L', 'confirmed'], ['pão', null, null, 'confirmed'], ['ovos', '2001', 'Ovos M', 'not_applied']]);
  run(db, false, '2026-10-08T10:00:00Z', [['Leite meio gordo', '1001', 'Leite Mimosa 1 L', 'confirmed'], ['Pão ', null, null, 'unknown'], ['leite', '1001', 'Leite Mimosa 1 L', 'confirmed']]);
  run(db, false, '2026-10-15T10:00:00Z', [['leite', '1001', 'Leite Mimosa 1 L', 'confirmed'], ['café', '3001', 'Café Delta', 'simulated']]);
  run(db, true, '2026-10-20T10:00:00Z', [['café', '3001', 'Café Delta', 'confirmed'], ['ovos', '2001', 'Ovos M', 'confirmed']]);
}

describe('sent products (1.9.0)', () => {
  it('groups by product, then by name; counts each send once; excludes test runs, not_applied and simulated', () => {
    const db = openDatabase(':memory:');
    seed(db);
    const out = sentProducts(db);
    expect(out.map(p => [p.key, p.sends])).toEqual([['p:1001', 3], ['n:pão', 2]]);
    expect(out[0]).toMatchObject({ item_name: 'leite', product_name: 'Leite Mimosa 1 L', last_sent_at: '2026-10-15T10:00:00Z' });
  });

  it('migration backfills product_name from the product cache or a linked list item', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 0');
    // Apply up to schema 4 by running migrate on a db then rolling the extra column test via a fresh open.
    migrate(db);
    db.exec('ALTER TABLE history_items DROP COLUMN product_name; PRAGMA user_version = 4');
    db.prepare("INSERT INTO product_cache VALUES ('1001', ?, 'x')").run(JSON.stringify({ name: 'Leite Cache' }));
    db.prepare("INSERT INTO lists (id, name, created_at, updated_at) VALUES (1, 'l', 'x', 'x')").run();
    db.prepare("INSERT INTO items (list_id, name, added_by, version, created_at, updated_at, product_id, product_json) VALUES (1, 'ovos', 'a', 1, 'x', 'x', '2001', ?)").run(JSON.stringify({ product_id: '2001', name: 'Ovos Item' }));
    db.prepare("INSERT INTO history_runs (id, test_mode, status, created_at) VALUES (1, 0, 'done', 'x')").run();
    for (const pid of ['1001', '2001', '9999']) db.prepare("INSERT INTO history_items (run_id, item_name, product_id, outcome) VALUES (1, 'a', ?, 'confirmed')").run(pid);
    migrate(db);
    expect(db.prepare('SELECT product_id, product_name FROM history_items ORDER BY id').all().map(r => ({ ...r })))
      .toEqual([{ product_id: '1001', product_name: 'Leite Cache' }, { product_id: '2001', product_name: 'Ovos Item' }, { product_id: '9999', product_name: null }]);
  });

  it('endpoints work remotely, need auth, and add selected items as pending (linked when known)', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const app = buildApp({ config: testConfig({ ingressAddress: INGRESS }), db, version: 't' });
    expect(REMOTE_ROUTE.test('/api/v1/history/products')).toBe(true);
    expect(REMOTE_ROUTE.test('/api/v1/history/products/add')).toBe(true);
    expect((await app.inject({ url: '/api/v1/history/products', remoteAddress: '192.0.2.20' })).statusCode).toBe(401);
    const list = await app.inject({ url: '/api/v1/history/products', remoteAddress: INGRESS, headers: ha });
    expect(list.statusCode).toBe(200);
    expect(list.json().products).toHaveLength(2);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/history/products/add', remoteAddress: INGRESS, headers: ha, payload: { keys: [] } });
    expect(bad.statusCode).toBe(400);
    const add = await app.inject({ method: 'POST', url: '/api/v1/history/products/add', remoteAddress: INGRESS, headers: ha, payload: { keys: ['p:1001', 'n:pão', 'p:nope'] } });
    expect(add.statusCode).toBe(200);
    const items = add.json().items;
    expect(items.map((i: { name: string; state: string }) => [i.name, i.state])).toEqual([['leite', 'pending'], ['Pão', 'pending']]);
    expect(items[0].product).toMatchObject({ product_id: '1001', name: 'Leite Mimosa 1 L' });
    expect(items[1].product).toBeNull();
  });
});
