import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../src/queue.js';
import { LogLimiter, Metrics, Ring, TimedTransport, jobLine } from '../src/metrics.js';
import { CachedCatalog, TtlCache } from '../src/cache.js';
import { SessionKeepAlive } from '../src/keepalive.js';
import { MutationBlockedError, TestModeGuard } from '../src/mcp/continente.js';
import type { McpTransport } from '../src/mcp/client.js';
import type { CatalogReader } from '../src/catalog.js';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { asLan, testConfig } from './helpers.js';

const ok = (data: unknown = {}) => ({ status: 'success' as const, data });

describe('JobQueue priorities (1.5.0)', () => {
  it('runs one job at a time and lets waiting user jobs go before background jobs', async () => {
    const q = new JobQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = q.run(() => new Promise<void>(r => { release = r; }).then(() => { order.push('running'); }), { priority: 'background' });
    const bg = q.run(async () => { order.push('background'); }, { priority: 'background' });
    const normal = q.run(async () => { order.push('normal'); });
    const user = q.run(async () => { order.push('user'); }, { priority: 'user' });
    expect(q.length).toBe(4);
    expect(q.waiting()).toEqual({ user: 1, normal: 1, background: 1 });
    release();
    await Promise.all([first, bg, normal, user]);
    expect(order).toEqual(['running', 'user', 'normal', 'background']);
    expect(q.length).toBe(0);
  });

  it('keeps FIFO within a priority and survives failing jobs', async () => {
    const q = new JobQueue();
    const order: number[] = [];
    const a = q.run(async () => { order.push(1); throw new Error('x'); });
    const b = q.run(async () => { order.push(2); return 2; });
    await expect(a).rejects.toThrow('x');
    await expect(b).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
  });
});

describe('LogLimiter', () => {
  it('caps lines per window and reports suppressed lines', () => {
    let t = 0;
    const out: string[] = [];
    const l = new LogLimiter(s => out.push(s), 3, 60_000, () => t);
    for (let i = 0; i < 10; i++) l.log(`line ${i}`);
    expect(out).toEqual(['line 0', 'line 1', 'line 2']);
    t = 60_000;
    l.log('next');
    expect(out.slice(3)).toEqual(['[cesto] log: 7 line(s) suppressed (limit 3/min)', 'next']);
  });
});

describe('Metrics', () => {
  it('ring keeps only the last entries', () => {
    const r = new Ring<number>(3);
    for (let i = 0; i < 5; i++) r.push(i);
    expect(r.all()).toEqual([2, 3, 4]);
  });

  it('times calls per job, logs one summary line, and computes p50/p95/max', async () => {
    let t = 0;
    const lines: string[] = [];
    const m = new Metrics(new LogLimiter(s => lines.push(s)), false, { calls: 500, jobs: 100 }, () => t);
    const inner: McpTransport = { callTool: async name => { t += name === 'get_product' ? 200 : 100; return name === 'get_cart' ? { status: 'error', error: { code: 'not_authenticated', message: 'x' } } : ok(); }, close: async () => {} };
    const tt = new TimedTransport(inner, m, () => t);
    await m.job({ label: 'proposal', priority: 'normal', waitMs: 12 }, async () => {
      await tt.callTool('search_products', { query: 'leite' });
      await tt.callTool('search_products', { query: 'pão' });
      await tt.callTool('get_product', { productId: '1' });
      m.cacheHit('search_products');
    });
    await tt.callTool('get_cart', {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[cesto] job=proposal prio=normal ok wait_ms=12 run_ms=400 calls=3 mcp_ms=400 cache_hits=1 steps=search_products:2x200,get_product:1x200');
    const s = m.snapshot({ length: 0 });
    expect(s.tools.search_products).toEqual({ calls: 2, errors: 0, p50_ms: 100, p95_ms: 100, max_ms: 100 });
    expect(s.tools.get_cart!.errors).toBe(1);
    expect(s.session_lost).toBe(1);
    expect(s.errors).toEqual({ not_authenticated: 1 });
    expect(s.cache_hits).toBe(1);
    expect(m.idleMs()).toBe(0);
  });

  it('never records tool arguments', async () => {
    const m = new Metrics(null, true);
    const tt = new TimedTransport({ callTool: async () => ok(), close: async () => {} }, m);
    await tt.callTool('search_products', { query: 'secret-query' });
    expect(JSON.stringify(m.snapshot({ length: 0 }))).not.toContain('secret-query');
  });

  it('per-call lines only at debug level', async () => {
    const info: string[] = [], debug: string[] = [];
    const call = async (m: Metrics) => new TimedTransport({ callTool: async () => ok(), close: async () => {} }, m).callTool('get_cart', {});
    await call(new Metrics(new LogLimiter(s => info.push(s)), false));
    await call(new Metrics(new LogLimiter(s => debug.push(s)), true));
    expect(info).toEqual([]);
    expect(debug[0]).toMatch(/^\[cesto\] mcp tool=get_cart ms=\d+ ok$/);
  });

  it('counts throttling and sign-in failures', async () => {
    const m = new Metrics(null, false);
    m.call('search_products', 5, { status: 'error', error: { code: 'upstream_unavailable', message: 'HTTP 429 Too Many Requests' } });
    m.signInFailed();
    const s = m.snapshot({ length: 0 });
    expect(s.throttled).toBe(1);
    expect(s.captcha_or_sign_in_failures).toBe(1);
  });

  it('job line format is stable', () => {
    expect(jobLine({ at: '', label: 'apply', priority: 'user', wait_ms: 0, run_ms: 5, calls: 0, mcp_ms: 0, cache_hits: 0, steps: {}, ok: false }))
      .toBe('[cesto] job=apply prio=user failed wait_ms=0 run_ms=5 calls=0 mcp_ms=0 cache_hits=0 steps=-');
  });

  it('TimedTransport keeps the test-mode guard in front: mutations never reach the MCP in test mode', async () => {
    const inner = { callTool: vi.fn(async () => ok()), close: async () => {} };
    const guard = new TestModeGuard(new TimedTransport(inner, new Metrics(null, false)), () => true);
    await expect(guard.callTool('set_cart_item_quantity', { productId: '1', quantity: 1 })).rejects.toBeInstanceOf(MutationBlockedError);
    await expect(guard.callTool('checkout', {})).rejects.toThrow();
    expect(inner.callTool).not.toHaveBeenCalled();
  });
});

describe('TTL caches', () => {
  it('expires entries and bounds size', () => {
    let t = 0;
    const c = new TtlCache<number>(100, 2, () => t);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    t = 100;
    expect(c.get('b')).toBeUndefined();
  });

  it('caches successful searches and products, not errors or habits', async () => {
    let t = 0;
    const inner = {
      searchProducts: vi.fn(async (a: { query: string }) => a.query === 'bad' ? { status: 'error' as const, error: { code: 'upstream_unavailable', message: '' } } : ok({ products: [{ productId: '1' }] })),
      getProduct: vi.fn(async () => ok({ product: { productId: '1', unitPrice: 1 } })),
      listFrequentlyBought: vi.fn(async () => ok()),
      listFavorites: vi.fn(async () => ok()),
    } satisfies CatalogReader;
    const hits: string[] = [];
    const c = new CachedCatalog(inner, { now: () => t, onHit: tool => hits.push(tool) });
    const a = await c.searchProducts({ query: 'Leite ', limit: 10 });
    const b = await c.searchProducts({ query: 'leite', limit: 10 });
    expect(b).toEqual(a);
    expect(inner.searchProducts).toHaveBeenCalledTimes(1);
    (b.data as { products: unknown[] }).products.length = 0; // callers may mutate: the cache keeps its own copy
    expect(((await c.searchProducts({ query: 'leite', limit: 10 })).data as { products: unknown[] }).products).toHaveLength(1);
    await c.searchProducts({ query: 'leite', limit: 20 });
    expect(inner.searchProducts).toHaveBeenCalledTimes(2);
    await c.searchProducts({ query: 'bad' }); await c.searchProducts({ query: 'bad' });
    expect(inner.searchProducts).toHaveBeenCalledTimes(4);
    await c.getProduct('1'); await c.getProduct('1');
    expect(inner.getProduct).toHaveBeenCalledTimes(1);
    t = 6 * 3600_000;
    await c.getProduct('1');
    expect(inner.getProduct).toHaveBeenCalledTimes(2);
    await c.searchProducts({ query: 'leite', limit: 10 }); // 8 h TTL: still cached at 6 h
    expect(inner.searchProducts).toHaveBeenCalledTimes(4);
    await c.listFavorites(); await c.listFavorites(); await c.listFrequentlyBought(); await c.listFrequentlyBought();
    expect(inner.listFavorites).toHaveBeenCalledTimes(2);
    expect(inner.listFrequentlyBought).toHaveBeenCalledTimes(2);
    expect(hits).toContain('get_product');
    c.clear();
    expect(c.stats().search.entries).toBe(0);
  });

  it('exposes no cart methods: cart reads, previews and writes stay live', () => {
    const c = new CachedCatalog({ searchProducts: async () => ok(), getProduct: async () => ok(), listFrequentlyBought: async () => ok(), listFavorites: async () => ok() });
    for (const m of ['getCart', 'previewCartChanges', 'setQuantity', 'clearCart']) expect((c as unknown as Record<string, unknown>)[m]).toBeUndefined();
  });
});

describe('SessionKeepAlive', () => {
  const make = (over: Partial<ConstructorParameters<typeof SessionKeepAlive>[0]> = {}) => {
    const check = vi.fn(async () => true as boolean | null);
    return { check, k: new SessionKeepAlive({ check, sessionValid: () => true, signingIn: () => false, idleMs: () => null, ...over }) };
  };
  it('waits 20-30 minutes with jitter', () => {
    expect(make({ random: () => 0 }).k.nextDelay()).toBe(20 * 60_000);
    expect(make({ random: () => 1 }).k.nextDelay()).toBe(30 * 60_000);
  });
  it('checks when idle and skips when busy, signing in or already expired', async () => {
    const a = make(); expect(await a.k.tick()).toBe(true); expect(a.check).toHaveBeenCalledOnce();
    const b = make({ idleMs: () => 60_000 }); expect(await b.k.tick()).toBe(false);
    const c = make({ signingIn: () => true }); expect(await c.k.tick()).toBe(false);
    const d = make({ sessionValid: () => false }); expect(await d.k.tick()).toBe(false);
    expect(b.check).not.toHaveBeenCalled(); expect(c.check).not.toHaveBeenCalled(); expect(d.check).not.toHaveBeenCalled();
  });
  it('logs when the session turns out to be expired and survives errors', async () => {
    const log: string[] = [];
    const k = new SessionKeepAlive({ check: async () => false, sessionValid: () => null, signingIn: () => false, idleMs: () => 31 * 60_000, log: l => log.push(l) });
    await k.tick();
    expect(log[0]).toMatch(/session has expired/);
    const e = new SessionKeepAlive({ check: async () => { throw new Error('x'); }, sessionValid: () => null, signingIn: () => false, idleMs: () => null });
    await expect(e.tick()).resolves.toBe(true);
  });
});

describe('GET /api/v1/admin/metrics', () => {
  const build = (metrics?: () => unknown) => buildApp({ config: testConfig(), db: openDatabase(':memory:'), version: 't', metrics });
  it('returns the snapshot through ingress for admins', async () => {
    const app = build(() => ({ tools: {} }));
    const r = await app.inject('/api/v1/admin/metrics');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ tools: {} });
  });
  it('is refused for non-admin HA users and from the LAN, even with a token', async () => {
    const app = build(() => ({}));
    expect((await app.inject({ url: '/api/v1/admin/metrics', headers: { 'x-remote-user-id': 'u', 'x-remote-user-groups': 'system-users' } })).statusCode).toBe(403);
    const lan = asLan(build(() => ({})));
    expect((await lan.inject({ url: '/api/v1/admin/metrics', headers: { authorization: 'Bearer x' } })).statusCode).toBe(403);
  });
  it('503 without metrics', async () => {
    expect((await build().inject('/api/v1/admin/metrics')).statusCode).toBe(503);
  });
});

describe('job priorities at the call sites', () => {
  it('promotion searches are queued as background work', async () => {
    const { PromotionSearches } = await import('../src/promotions.js');
    const seen: unknown[] = [];
    const run = (async (job: () => Promise<unknown>, o?: unknown) => { seen.push(o); return job(); }) as never;
    new PromotionSearches({ suggestOne: async () => null } as never, run);
    const s = new PromotionSearches({} as never, run) as unknown as { run: (j: () => Promise<number>) => Promise<number> };
    await s.run(async () => 1);
    expect(seen).toEqual([{ priority: 'background', label: 'promotions' }]);
  });
});
