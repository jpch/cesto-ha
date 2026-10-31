import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioMcpTransport } from '../src/mcp/client.js';
import { CartWriter, ContinenteMcp, MutationBlockedError, TestModeGuard } from '../src/mcp/continente.js';
import { MUTATING_TOOLS, READ_TOOLS } from '../src/mcp/tools.js';
import { JobQueue } from '../src/queue.js';

const FAKE = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
const open: StdioMcpTransport[] = [];

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  const log = join(dir, 'calls.jsonl');
  const transport = new StdioMcpTransport({ command: process.execPath, args: [FAKE], env: { FAKE_MCP_LOG: log, FAKE_MCP_STATE: join(dir, 'state'), ...env } });
  open.push(transport);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { name: string; args: unknown; pid: number }) : []);
  return { transport, calls };
}

afterEach(async () => { await Promise.all(open.splice(0).map(t => t.close())); });

describe('MCP client', () => {
  it('calls read tools through the typed wrapper', async () => {
    const { transport, calls } = setup();
    const mcp = new ContinenteMcp(new TestModeGuard(transport, () => true));
    const res = await mcp.searchProducts({ query: 'leite', limit: 3 });
    expect(res.status).toBe('success');
    expect(res.data).toMatchObject({ products: [{ productId: '4421406' }] });
    expect(calls().map(c => c.name)).toEqual(['search_products']);
  });

  it('test mode: no mutating tool ever reaches the MCP transport', async () => {
    let testMode = true;
    const { transport, calls } = setup();
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

  it('lists all 15 tools in exactly one category', () => {
    expect(new Set([...READ_TOOLS, ...MUTATING_TOOLS]).size).toBe(15);
  });

  it('detects an expired session and emits a session event', async () => {
    const { transport } = setup({ FAKE_MCP_MODE: 'not_authenticated' });
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

  it('restarts the MCP process after a crash and retries read calls', async () => {
    const { transport, calls } = setup({ FAKE_MCP_MODE: 'crash_once' });
    const mcp = new ContinenteMcp(transport);
    const res = await mcp.getCart();
    expect(res.status).toBe('success');
    expect(transport.restarts).toBe(1);
    const pids = new Set(calls().map(c => c.pid));
    expect(pids.size).toBe(2);
  });

  it('never retries a mutation after a crash', async () => {
    const { transport, calls } = setup({ FAKE_MCP_MODE: 'crash_once' });
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
