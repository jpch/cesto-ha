import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { buildApp, NEVER_REMOTE, PreviewRuns, REMOTE_CART_LIMIT, REMOTE_CART_ROUTE, REMOTE_ROUTE, remoteCartLine } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { testConfig } from './helpers.js';

const INGRESS = '172.30.32.2';
const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'alex', 'x-remote-user-display-name': 'Alex' };
const UUID = '00000000-0000-4000-8000-000000000001';

async function setup(remoteCart: boolean) {
  const { catalog } = fixtureCatalog();
  const lines: string[] = [];
  const cartCalls: string[] = [];
  // Never the real cart: a fake that records reads and refuses writes.
  const app = buildApp({
    config: testConfig({ ingressAddress: INGRESS, testMode: true, remoteCart }), db: openDatabase(':memory:'), version: 't', catalog,
    cart: {
      getCart: async () => { cartCalls.push('get'); return { status: 'success', data: { items: [] } }; },
      previewCartChanges: async () => { cartCalls.push('preview'); return { status: 'success', data: {} }; },
      setQuantity: async () => { throw new Error('cart must not be reached'); }, clearCart: async () => { throw new Error('cart must not be reached'); },
    },
    remoteCartLog: l => lines.push(l),
  });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', remoteAddress: INGRESS, payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', remoteAddress: INGRESS, headers: ha, payload: { name: 'Leite' } });
  return { app, lines, cartCalls, token };
}

describe('remote_cart option (1.7.0)', () => {
  it('defaults to off and only an explicit true turns it on', () => {
    const dir = '/tmp/cesto-remote-cart-test.json';
    for (const [v, want] of [[undefined, false], ['true', false], [1, false], [true, true]] as const) {
      writeFileSync(dir, JSON.stringify(v === undefined ? {} : { remote_cart: v }));
      expect(loadConfig({ OPTIONS_PATH: dir }).remoteCart, String(v)).toBe(want);
    }
  });

  it('off: cart routes stay 403 remote_forbidden through ingress; /health reports remote_cart false', async () => {
    const { app } = await setup(false);
    const r = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', remoteAddress: INGRESS, headers: ha, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message_key).toBe('error.remote_forbidden');
    expect((await app.inject({ url: '/api/v1/health', remoteAddress: INGRESS })).json().remote_cart).toBe(false);
  });

  it('on: proposal, line edit, async preview and apply work remotely in test mode, logged per mutation by device', async () => {
    const { app, lines, cartCalls } = await setup(true);
    expect((await app.inject({ url: '/api/v1/health', remoteAddress: INGRESS })).json().remote_cart).toBe(true);
    const p = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', remoteAddress: INGRESS, headers: ha, payload: {} });
    expect(p.statusCode).toBe(201);
    const id = p.json().proposal_id as string;
    const line = p.json().lines[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/basket/proposals/${id}/lines/${line.item_id}`, remoteAddress: INGRESS, headers: ha, payload: { product_id: (line.selected ?? line.options[0]).product_id, quantity: 2 } })).statusCode).toBe(200);
    const start = await app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/preview`, remoteAddress: INGRESS, headers: ha, payload: { async: true } });
    expect(start.statusCode).toBe(202);
    let run = start.json();
    for (let i = 0; i < 50 && run.status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 5));
      run = (await app.inject({ url: `/api/v1/basket/proposals/${id}/previews/${run.preview_run_id}`, remoteAddress: INGRESS, headers: ha })).json();
    }
    expect(run.error).toBeNull(); expect(run.status).toBe('done');
    const apply = await app.inject({ method: 'POST', url: `/api/v1/basket/proposals/${id}/apply`, remoteAddress: INGRESS, headers: ha, payload: { preview_id: run.preview.preview_id } });
    expect(apply.statusCode).toBe(202);
    const job = await app.inject({ url: `/api/v1/jobs/${apply.json().job_id}`, remoteAddress: INGRESS, headers: ha });
    expect(job.statusCode).toBe(200);
    expect(cartCalls.every(c => c === 'get' || c === 'preview')).toBe(true);
    expect(lines.length).toBe(4); // proposal, line edit, preview, apply; GET polls are not logged
    expect(lines[0]).toMatch(/^\[cesto\] remote_cart POST \/api\/v1\/basket\/proposals 201 by=ha-user:u1 \d+ms$/);
    expect(lines[1]).toContain('PATCH /api/v1/basket/proposals/:id/lines/:n 200');
    expect(lines.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('on: a device token is logged by id, never the token', async () => {
    const { app, lines, token } = await setup(true);
    await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', remoteAddress: INGRESS, headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(lines[0]).toMatch(/by=token#\d+ /);
    expect(lines[0]).not.toContain(token);
  });

  it('on: checkout, payment, order and address paths stay refused; admin stays admin-only', async () => {
    const { app } = await setup(true);
    for (const url of ['/api/v1/checkout', '/api/v1/basket/checkout', '/api/v1/payment', '/api/v1/basket/proposals/x/pay', '/api/v1/orders', '/api/v1/address', '/api/v1/cart', '/api/v1/mcp', '/api/v1/preferences', '/api/v1/habits/refresh'])
      expect((await app.inject({ method: 'POST', url, remoteAddress: INGRESS, headers: ha, payload: {} })).statusCode, url).toBe(403);
    expect((await app.inject({ url: '/api/v1/admin/tokens', remoteAddress: INGRESS, headers: { ...ha, 'x-remote-user-groups': 'system-users' } })).statusCode).toBe(403);
    expect(NEVER_REMOTE.test('/api/v1/basket/proposals')).toBe(false);
  });

  it('on: HA auth is still required', async () => {
    const { app } = await setup(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', remoteAddress: INGRESS, payload: {} })).statusCode).toBe(401);
  });

  it('on: remote cart mutations are rate limited per device; polling is not', async () => {
    const { app, token } = await setup(true);
    const url = `/api/v1/basket/proposals/${UUID}/apply`;
    for (let i = 0; i < REMOTE_CART_LIMIT; i++) expect((await app.inject({ method: 'POST', url, remoteAddress: INGRESS, headers: ha, payload: {} })).statusCode).not.toBe(429);
    const limited = await app.inject({ method: 'POST', url, remoteAddress: INGRESS, headers: ha, payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.message_key).toBe('error.rate_limited');
    expect((await app.inject({ url: `/api/v1/jobs/${UUID}`, remoteAddress: INGRESS, headers: ha })).statusCode).not.toBe(429);
    // Another device has its own budget.
    expect((await app.inject({ method: 'POST', url, remoteAddress: INGRESS, headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).not.toBe(429);
  });

  it('the LAN path is unchanged and never rate limited by the remote budget', async () => {
    const { app, token } = await setup(false);
    const url = `/api/v1/basket/proposals/${UUID}/apply`;
    for (let i = 0; i < REMOTE_CART_LIMIT + 2; i++)
      expect((await app.inject({ method: 'POST', url, remoteAddress: '192.0.2.20', headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).not.toBe(429);
  });

  it('cart allowlist matches only cart routes with well-formed ids', () => {
    for (const url of ['/api/v1/basket/proposals', `/api/v1/basket/proposals/${UUID}`, `/api/v1/basket/proposals/${UUID}/lines/5`, `/api/v1/basket/proposals/${UUID}/preview`,
      `/api/v1/basket/proposals/${UUID}/previews/${UUID}`, `/api/v1/basket/proposals/${UUID}/apply`, `/api/v1/jobs/${UUID}`, `/api/v1/jobs/${UUID}/retry-missing`,
      '/api/v1/promotions', '/api/v1/promotions/searches', `/api/v1/promotions/searches/${UUID}`, '/api/v1/photos', `/api/v1/photos/${UUID}/thumbnail`])
      expect(REMOTE_CART_ROUTE.test(url), url).toBe(true);
    for (const url of ['/api/v1/basket/proposals/1/apply', '/api/v1/basket/proposals/x/../../admin', `/api/v1/jobs/${UUID}/x`, '/api/v1/preferences', '/api/v1/habits', '/api/v1/cart'])
      expect(REMOTE_CART_ROUTE.test(url), url).toBe(false);
  });

  it('openapi.yaml tags exactly the remote-cart operations', () => {
    const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { tags?: string[] }>> };
    for (const [path, m] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(m)) {
      const url = `/api/v1${path.replace(/\{(\w+)\}/g, (_x, k: string) => (k === 'item_id' ? '5' : UUID))}`;
      expect(!!op.tags?.includes('remote-cart'), `${method} ${path}`).toBe(REMOTE_CART_ROUTE.test(url) && !REMOTE_ROUTE.test(url));
    }
  });

  it('log line and preview runs are bounded', async () => {
    expect(remoteCartLine('POST', `/api/v1/jobs/${UUID}/retry-missing`, 202, 'token#3\nx', 12)).toBe('[cesto] remote_cart POST /api/v1/jobs/:id/retry-missing 202 by=token#3_x 12ms');
    let t = 0;
    const runs = new PreviewRuns(3, 1000, () => t);
    const ids = [1, 2, 3, 4].map(() => runs.start('p', () => new Promise(() => {})).preview_run_id);
    expect(runs.get(ids[0]!)).toBeUndefined();
    expect(runs.get(ids[3]!)).toBeDefined();
    t = 2000;
    expect(runs.get(ids[3]!)).toBeUndefined();
  });
});
