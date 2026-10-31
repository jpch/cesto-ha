import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { buildApp, REMOTE_ROUTE } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { testConfig } from './helpers.js';

const INGRESS = '172.30.32.2';
const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'alex', 'x-remote-user-display-name': 'Alex' };

async function setup() {
  const { catalog, calls } = fixtureCatalog();
  const app = buildApp({ config: testConfig({ ingressAddress: INGRESS, testMode: false }), db: openDatabase(':memory:'), version: '0.2.0', catalog,
    cart: { getCart: async () => ({ status: 'success', data: {} }), previewCartChanges: async () => ({ status: 'success', data: {} }),
      setQuantity: async () => { throw new Error('cart must not be reached'); }, clearCart: async () => { throw new Error('cart must not be reached'); } } });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', remoteAddress: INGRESS, payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  return { app, calls, token };
}

/** Every non-admin operation in openapi.yaml, with sample path parameters. */
function operations() {
  const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const ops: { method: string; url: string }[] = [];
  for (const [path, m] of Object.entries(spec.paths)) for (const method of ['get', 'post', 'put', 'patch', 'delete'])
    if (m[method] && !path.startsWith('/admin/')) ops.push({ method: method.toUpperCase(), url: `/api/v1${path.replace(/\{(\w+)\}/g, (_x, k: string) => (k === 'item_key' || k === 'id' && path.startsWith('/photos') ? 'abc' : '1'))}` });
  return ops;
}

describe('remote access through Home Assistant (ingress)', () => {
  it('reaches the list API with the HA identity, no add-on token needed', async () => {
    const { app } = await setup();
    const add = await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', remoteAddress: INGRESS, headers: ha, payload: { name: 'Leite' } });
    expect(add.statusCode).toBe(201);
    expect(add.json().added_by).toBe('Alex');
    const list = await app.inject({ url: '/api/v1/lists/current', remoteAddress: INGRESS, headers: ha });
    expect(list.json().items.map((i: { name: string }) => i.name)).toEqual(['Leite']);
    expect((await app.inject({ url: '/api/v1/me', remoteAddress: INGRESS, headers: ha })).json()).toMatchObject({ name: 'Alex', kind: 'ha' });
    expect((await app.inject({ url: '/api/v1/lists/current', remoteAddress: INGRESS })).statusCode).toBe(401);
  });

  it('never exposes cart, basket, jobs, photos, promotions, preferences or habits remotely, even with a valid add-on token', async () => {
    const { app, calls, token } = await setup();
    const blocked = operations().filter(o => !REMOTE_ROUTE.test(o.url.split('?')[0]!));
    expect(blocked.map(o => o.url)).toEqual(expect.arrayContaining(['/api/v1/basket/proposals', '/api/v1/basket/proposals/1/apply', '/api/v1/jobs/1', '/api/v1/promotions', '/api/v1/photos']));
    for (const o of blocked) {
      const res = await app.inject({ method: o.method as 'GET', url: o.url, remoteAddress: INGRESS, headers: { ...ha, authorization: `Bearer ${token}` }, payload: o.method === 'GET' || o.method === 'DELETE' ? undefined : {} });
      expect(res.statusCode, `${o.method} ${o.url}`).toBe(403);
      expect(res.json().error.message_key).toBe('error.remote_forbidden');
    }
    for (const url of ['/api/v1/mcp', '/api/v1/cart', '/api/v1/checkout', '/api/v1/lists/current/../../basket/proposals'])
      expect((await app.inject({ url, remoteAddress: INGRESS, headers: ha })).statusCode, url).toBe(403);
    expect(calls).toEqual([]);
  });

  it('openapi.yaml tags exactly the remote operations', () => {
    const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { tags?: string[] }>> };
    for (const [path, m] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(m)) {
      const url = `/api/v1${path.replace(/\{(\w+)\}/g, '1')}`;
      expect(!!op.tags?.includes('remote'), `${method} ${path}`).toBe(REMOTE_ROUTE.test(url));
    }
  });

  it('non-admin HA users get the list but never the add-on page or admin routes', async () => {
    const { app } = await setup();
    const user = { ...ha, 'x-remote-user-groups': 'system-users' };
    expect((await app.inject({ url: '/api/v1/lists/current', remoteAddress: INGRESS, headers: user })).statusCode).toBe(200);
    for (const url of ['/', '/api/v1/admin/status', '/api/v1/admin/tokens'])
      expect((await app.inject({ url, remoteAddress: INGRESS, headers: user })).statusCode, url).toBe(403);
    const admin = { ...ha, 'x-remote-user-groups': 'system-admin' };
    expect((await app.inject({ url: '/api/v1/admin/status', remoteAddress: INGRESS, headers: admin })).statusCode).toBe(200);
  });

  it('the remote allowlist only matches list routes', () => {
    for (const url of ['/api/v1/lists/current', '/api/v1/lists/current/changes', '/api/v1/lists/current/items', '/api/v1/items/7', '/api/v1/lists/history/3/repeat', '/api/v1/health'])
      expect(REMOTE_ROUTE.test(url), url).toBe(true);
    for (const url of ['/api/v1/basket/proposals', '/api/v1/jobs/x', '/api/v1/promotions', '/api/v1/photos', '/api/v1/preferences', '/api/v1/habits', '/api/v1/items/7/x', '/api/v1/lists/currentx'])
      expect(REMOTE_ROUTE.test(url), url).toBe(false);
  });

  it('the LAN (direct port) keeps the full API with an add-on token, and ignores HA identity headers', async () => {
    const { app, token } = await setup();
    expect((await app.inject({ url: '/api/v1/lists/current', remoteAddress: '192.0.2.20', headers: ha })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/promotions', remoteAddress: '192.0.2.20', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });
});

describe('1.2.0: product search from outside and add-on slug', () => {
  it('searches the catalogue through ingress (read-only) and rate limits per HA user', async () => {
    const { app } = await setup();
    const first = await app.inject({ method: 'POST', url: '/api/v1/catalog/search', remoteAddress: INGRESS, headers: ha, payload: { query: 'leite' } });
    expect(first.statusCode).toBe(200);
    for (let i = 1; i < 10; i++) await app.inject({ method: 'POST', url: '/api/v1/catalog/search', remoteAddress: INGRESS, headers: ha, payload: { query: 'leite' } });
    const limited = await app.inject({ method: 'POST', url: '/api/v1/catalog/search', remoteAddress: INGRESS, headers: ha, payload: { query: 'leite' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.message_key).toBe('error.rate_limited');
    const other = await app.inject({ method: 'POST', url: '/api/v1/catalog/search', remoteAddress: INGRESS, headers: { ...ha, 'x-remote-user-id': 'u2' }, payload: { query: 'pão' } });
    expect(other.statusCode).toBe(200);
  });

  it('search still needs HA authentication through ingress', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/v1/catalog/search', remoteAddress: INGRESS, payload: { query: 'leite' } })).statusCode).toBe(401);
  });

  it('health and the pairing QR carry the add-on slug', async () => {
    const app = buildApp({ config: testConfig({ ingressAddress: INGRESS, addonSlug: '0369824b_cesto' }), db: openDatabase(':memory:'), version: '1.2.0' });
    expect((await app.inject({ url: '/api/v1/health', remoteAddress: '192.0.2.20' })).json().addon_slug).toBe('0369824b_cesto');
    const pair = await app.inject({ method: 'POST', url: '/api/v1/admin/pair', remoteAddress: INGRESS, payload: { name: 'Ana', address: 'http://192.0.2.10:8099' } });
    expect(pair.json().uri).toMatch(/&slug=0369824b_cesto$/);
  });
});

describe('1.2.1: access log', () => {
  it('logs failed requests with the cause and never the token', async () => {
    const lines: string[] = [];
    const app = buildApp({ config: testConfig({ ingressAddress: INGRESS }), db: openDatabase(':memory:'), version: '1.2.1', accessLog: l => lines.push(l) });
    await app.inject({ url: '/api/v1/lists/current?since=3', remoteAddress: '192.0.2.20', headers: { authorization: 'Bearer cesto_secretsecretsecret' } });
    await app.inject({ url: '/api/v1/lists/current', remoteAddress: '192.0.2.20' });
    await app.inject({ url: '/api/v1/health', remoteAddress: '192.0.2.20' });
    expect(lines).toEqual([
      expect.stringMatching(/^\[cesto\] GET \/api\/v1\/lists\/current 401 via=lan by=anonymous \(unknown or revoked token\) \d+ms$/),
      expect.stringMatching(/^\[cesto\] GET \/api\/v1\/lists\/current 401 via=lan by=anonymous \(no token\) \d+ms$/),
    ]);
    expect(lines.join('\n')).not.toContain('secret');
  });
});
