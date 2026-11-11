import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLIENT_VERSION, HttpMcpTransport } from '../src/mcp/client.js';
import { CartWriter, ContinenteMcp, MutationBlockedError, TestModeGuard } from '../src/mcp/continente.js';
import { MUTATING_TOOLS, READ_TOOLS } from '../src/mcp/tools.js';
import { JobQueue } from '../src/queue.js';
import { startFakeMcp, type FakeMcp } from './fake-mcp.mjs';

const open: { transport: HttpMcpTransport; fake: FakeMcp }[] = [];

async function setup(mode: 'ok' | 'not_authenticated' | 'drop_once' = 'ok') {
  const fake = await startFakeMcp({ mode });
  const transport = new HttpMcpTransport({ endpoint: () => fake.url, token: () => fake.token });
  open.push({ transport, fake });
  return { transport, calls: () => fake.calls };
}

afterEach(async () => { await Promise.all(open.splice(0).map(async o => { await o.transport.close(); await o.fake.close(); })); });

describe('MCP client', () => {
  it('calls read tools through the typed wrapper', async () => {
    const { transport, calls } = await setup();
    const mcp = new ContinenteMcp(new TestModeGuard(transport, () => true));
    const res = await mcp.searchProducts({ query: 'leite', limit: 3 });
    expect(res.status).toBe('success');
    expect(res.data).toMatchObject({ products: [{ productId: '4421406' }] });
    expect(calls().map(c => c.name)).toEqual(['search_products']);
  });

  it('test mode: no mutating tool ever reaches the MCP transport', async () => {
    let testMode = true;
    const { transport, calls } = await setup();
    const guard = new TestModeGuard(transport, () => testMode);
    const mcp = new ContinenteMcp(guard);
    const writer = new CartWriter(mcp, () => testMode);

    const results = [await writer.addItem('1', 2), await writer.setQuantity('1', 3), await writer.removeItem('1'), await writer.clearCart()];
    expect(results.every(r => r.simulated && r.data?.outcome === 'simulated')).toBe(true);
    expect(writer.simulatedLog.map(l => l.tool)).toEqual(['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart']);

    // Even bypassing CartWriter, the guard refuses every mutating tool.
    for (const tool of MUTATING_TOOLS) {
      await expect(guard.callTool(tool, { productId: '1', quantity: 1 })).rejects.toBeInstanceOf(MutationBlockedError);
      await expect(mcp.mutate(tool, { productId: '1', quantity: 1 })).rejects.toBeInstanceOf(MutationBlockedError);
    }
    await expect(mcp.read('add_cart_item' as never)).rejects.toBeInstanceOf(MutationBlockedError);
    await mcp.previewCartChanges([{ productId: '1', quantity: 1 }]);

    const sent = calls().map(c => c.name);
    expect(sent).toEqual(['preview_cart_changes']);
    expect(sent.some(n => (MUTATING_TOOLS as readonly string[]).includes(n))).toBe(false);

    // Only with test mode off does a mutation go out.
    testMode = false;
    const real = await writer.addItem('1', 1);
    expect(real.simulated).toBeUndefined();
    expect(calls().map(c => c.name)).toEqual(['preview_cart_changes', 'add_cart_item']);
  });

  it('introduces itself to the add-on with the add-on version from package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CLIENT_VERSION).toBe(pkg.version);
    const { transport } = await setup();
    await new ContinenteMcp(transport).getCart();
    expect(open.at(-1)!.fake.clients).toEqual([{ name: 'cesto-ha', version: pkg.version }]);
  });

  it('lists all 15 tools in exactly one category', () => {
    expect(new Set([...READ_TOOLS, ...MUTATING_TOOLS]).size).toBe(15);
  });

  it('detects an expired session and emits a session event', async () => {
    const { transport } = await setup('not_authenticated');
    const mcp = new ContinenteMcp(transport);
    const events: (boolean | null)[] = [];
    mcp.on('session', v => events.push(v));
    await mcp.searchProducts({ query: 'pão' });
    expect(mcp.sessionValid).toBe(true);
    const res = await mcp.getCart();
    expect(res.error?.code).toBe('not_authenticated');
    expect(mcp.sessionValid).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('retries a read once after the connection to the add-on drops', async () => {
    const { transport, calls } = await setup('drop_once');
    const mcp = new ContinenteMcp(transport);
    const res = await mcp.getCart();
    expect(res.status).toBe('success');
    expect(calls().map(c => c.name)).toEqual(['get_cart', 'get_cart']);
  });

  it('never retries a mutation after the connection drops', async () => {
    const { transport, calls } = await setup('drop_once');
    const writer = new CartWriter(new ContinenteMcp(transport), () => false);
    await expect(writer.addItem('1', 1)).rejects.toBeDefined();
    expect(calls().filter(c => c.name === 'add_cart_item')).toHaveLength(1);
  });
});

describe('JobQueue', () => {
  it('runs one job at a time in order and survives failures', async () => {
    const q = new JobQueue();
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (id: string, fail = false) => async () => {
      running++; maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 10));
      order.push(id); running--;
      if (fail) throw new Error(id);
      return id;
    };
    const all = [q.run(job('a')), q.run(job('b', true)), q.run(job('c'))];
    expect(q.length).toBe(3);
    const settled = await Promise.allSettled(all);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(settled.map(s => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(q.length).toBe(0);
  });
});
