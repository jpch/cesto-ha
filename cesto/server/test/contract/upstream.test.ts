/**
 * Contract tests for continentept-mcp (no Continente login needed, safe for CI).
 *
 * - upstream-tools.json is the reviewed snapshot of tools/list (names, input and output schemas) from
 *   the installed package; scripts/upstream-tools.mjs --check compares it with the live package.
 * - fixtures/ holds recorded, anonymised results; each must validate against its tool's output schema,
 *   and each adapter in src/mcp/upstream.ts is checked against them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ALLOWED_TOOLS, FORBIDDEN_TOOL, MUTATING_TOOLS, READ_TOOLS, isForbidden, type ToolResult } from '../../src/mcp/tools.js';
import { CartWriter, ContinenteMcp, MutationBlockedError, TestModeGuard } from '../../src/mcp/continente.js';
import type { McpTransport } from '../../src/mcp/client.js';
import * as up from '../../src/mcp/upstream.js';
import { quantityInCart } from '../../src/basket.js';
import { FORBIDDEN, diff, normalise, report } from '../../scripts/upstream-tools.mjs';

interface Tool { name: string; inputSchema: object; outputSchema: object }
const dir = new URL('./', import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL('upstream-tools.json', dir), 'utf8')) as { version: string; tools: Tool[] };
const FIXTURES = readdirSync(new URL('fixtures/', dir)).filter(f => f.endsWith('.json')).sort();
const raw = (name: string) => readFileSync(new URL(`fixtures/${name}.json`, dir), 'utf8');
/** The ToolResult StdioMcpTransport returns: structuredContent.result. */
const fx = (name: string) => (JSON.parse(raw(name)) as { result: ToolResult }).result;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const tool = (name: string) => snapshot.tools.find(t => t.name === name)!;
const validator = (name: string, kind: 'inputSchema' | 'outputSchema') => ajv.compile(tool(name)[kind]);

describe('upstream tool snapshot', () => {
  it('lists exactly the allowlisted tools: 11 read and 4 cart tools, nothing else', () => {
    expect(READ_TOOLS).toHaveLength(11);
    expect(MUTATING_TOOLS).toHaveLength(4);
    expect(snapshot.tools.map(t => t.name).sort()).toEqual([...ALLOWED_TOOLS].sort());
  });
  it('has an input and an output schema for every tool', () => {
    for (const t of snapshot.tools) {
      expect(t.inputSchema, t.name).toBeTypeOf('object');
      expect(t.outputSchema, t.name).toBeTypeOf('object');
    }
  });
  it('a new upstream tool is reported and stays forbidden until reviewed', () => {
    const live = [...snapshot.tools, { name: 'create_order', inputSchema: {}, outputSchema: {} }, { name: 'list_stores', inputSchema: {}, outputSchema: {} }];
    const d = diff(snapshot.tools, normalise(live));
    expect(d.added).toEqual(['create_order', 'list_stores']);
    expect(report(d, '9.9.9')).toContain('`create_order` **(checkout/payment-like name');
    expect(report(d, '9.9.9')).toContain('Auto-merge is blocked');
    expect(FORBIDDEN.source).toBe(FORBIDDEN_TOOL.source);
    expect(isForbidden('create_order')).toBe(true);
    expect(isForbidden('list_stores')).toBe(true);
  });
  it('a removed tool or a changed schema is reported', () => {
    const live = snapshot.tools.filter(t => t.name !== 'get_order').map(t => t.name === 'get_cart' ? { ...t, outputSchema: { type: 'object' } } : t);
    const d = diff(snapshot.tools, normalise(live));
    expect(d.removed).toEqual(['get_order']);
    expect(d.changed).toEqual([{ name: 'get_cart', parts: ['outputSchema'] }]);
    expect(diff(snapshot.tools, normalise(snapshot.tools))).toEqual({ added: [], removed: [], changed: [] });
  });
  it('ignores description text changes', () => {
    const live = snapshot.tools.map(t => ({ ...t, description: 'reworded', inputSchema: { ...t.inputSchema, description: 'reworded' } }));
    expect(diff(snapshot.tools, normalise(live))).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('recorded fixtures', () => {
  it('cover every allowlisted tool with at least one success fixture', () => {
    for (const name of ALLOWED_TOOLS) expect(FIXTURES.some(f => f.startsWith(`${name}.`) && fx(f.slice(0, -5)).status !== 'error'), name).toBe(true);
  });
  it.each(FIXTURES)('%s validates against the upstream output schema', file => {
    const [name] = file.split('.');
    expect(ALLOWED_TOOLS, file).toContain(name);
    const validate = validator(name, 'outputSchema');
    const ok = validate(JSON.parse(raw(file.slice(0, -5))));
    expect(ok, JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });
  it('are anonymised: no e-mail, phone, IP, personal host, token or real order data', () => {
    for (const file of FIXTURES) {
      const text = raw(file.slice(0, -5));
      expect(text, file).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text, file).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(text, file).not.toMatch(/\b9\d{8}\b|\+351/);
      expect(text, file).not.toMatch(/token|csrf|dwsid|"password"\s*:/i);
      expect(text, file).not.toMatch(/"[A-Za-z0-9+/_=-]{32,}"/);
      for (const host of text.match(/https?:\/\/[^/"]+/g) ?? []) expect(['https://www.continente.pt', 'https://github.com'], `${file}: ${host}`).toContain(host);
      for (const id of text.match(/"productId": "(\d+)"/g) ?? []) expect(id, file).toMatch(/"20000\d\d"/);
    }
  });
});

describe('adapters (src/mcp/upstream.ts) on recorded shapes', () => {
  it('search_products → products', () => {
    const products = up.productsOf(fx('search_products.success'));
    expect(products.map(p => p.productId)).toEqual(['2000001', '2000002', '2000003']);
    expect(products[0]).toMatchObject({ name: 'Leite UHT Meio-Gordo', price: { amount: { currency: 'EUR', minorUnits: 103 }, per: 'item' }, favorite: true, availability: 'available' });
    expect(products[2].promotions?.[0]).toMatchObject({ kind: 'multi_buy', bundle: { quantity: 3 } });
    expect(up.productsOf(fx('search_products.empty'))).toEqual([]);
  });
  it('get_product → product with sale rules, null on an error', () => {
    expect(up.productOf(fx('get_product.success'))).toMatchObject({ productId: '2000001', saleRules: { status: 'available', rules: { saleUnit: 'un' } } });
    expect(up.productOf(fx('get_product.kg'))?.saleRules?.rules?.saleUnit).toBe('kg');
    expect(up.productOf(fx('get_product.not_found'))).toBeNull();
  });
  it('list_favorites and list_frequently_bought_products', () => {
    expect(up.favoritesOf(fx('list_favorites.success')).map(p => p.productId)).toEqual(['2000001']);
    expect(up.frequentOf(fx('list_frequently_bought_products.success'))).toMatchObject([{ productId: '2000001', orders: 4 }, { productId: '2000002', orders: 3 }]);
    expect(up.favoritesOf(fx('list_favorites.not_authenticated'))).toEqual([]);
  });
  it('get_cart → product lines with numeric quantities; bags left out; unreadable quantity is null', () => {
    const items = up.cartItems(fx('get_cart.success'));
    expect(items).toEqual([{ productId: '2000001', quantity: 6 }, { productId: '2000002', quantity: 1.2 }, { productId: '2000004', quantity: null }]);
    expect(quantityInCart(items, '2000001')).toBe(6);
    expect(quantityInCart(items, '2000004')).toBeNull();
    expect(quantityInCart(items, '2000009')).toBe(0);
    expect(up.cartItems(fx('get_cart.empty'))).toEqual([]);
  });
  it('preview_cart_changes → problems list (unavailable and refused lines) and estimated cost', () => {
    const r = fx('preview_cart_changes.success');
    expect(up.previewProblems(r)).toEqual([
      { product_id: '2000003', name: 'Atum em Óleo Vegetal', availability: 'unavailable', error_key: null },
      { product_id: '2000005', name: null, availability: null, error_key: 'error.sale_rules_unknown' },
    ]);
    expect(up.previewProblems(r)).toHaveLength((r.data as { problems: number }).problems);
    expect(up.estimatedCostOf(r)).toEqual({ currency: 'EUR', minorUnits: 824 });
    expect(up.previewProblems(fx('preview_cart_changes.not_authenticated'))).toEqual([]);
  });
  it('cart mutations → outcome', () => {
    expect(up.mutationOutcome(fx('add_cart_item.success'))).toBe('confirmed');
    expect(up.mutationOutcome(fx('set_cart_item_quantity.success'))).toBe('confirmed');
    expect(up.mutationOutcome(fx('remove_cart_item.success'))).toBe('confirmed');
    expect(up.mutationOutcome(fx('clear_cart.success'))).toBe('confirmed');
    expect(up.mutationOutcome(fx('set_cart_item_quantity.unknown'))).toBe('unknown');
    expect(up.mutationOutcome(fx('set_cart_item_quantity.not_applied'))).toBe('not_applied');
    expect(up.mutationOutcome({ status: 'success', data: {} })).toBe('unknown');
    expect(up.mutationOutcome({ status: 'success', simulated: true })).toBe('simulated');
  });
  it('login/session states', () => {
    expect(up.sessionStateOf(fx('get_session_status.authenticated'))).toBe('authenticated');
    expect(up.sessionStateOf(fx('get_session_status.unauthenticated'))).toBe('unauthenticated');
    for (const f of ['get_cart', 'list_favorites', 'preview_cart_changes', 'list_frequently_bought_products', 'set_cart_item_quantity']) {
      expect(up.isNotAuthenticated(fx(`${f}.not_authenticated`)), f).toBe(true);
      expect(up.sessionStateOf(fx(`${f}.not_authenticated`)), f).toBe('unauthenticated');
    }
    expect(up.isNotAuthenticated(fx('get_cart.success'))).toBe(false);
  });
});

/** Replays fixtures by tool name and records every call. */
class Replay implements McpTransport {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly answers: Record<string, string>) {}
  async callTool(name: string, args: Record<string, unknown>) { this.calls.push({ name, args }); return fx(this.answers[name] ?? `${name}.success`); }
  async close() {}
}

describe('our calls match the upstream input schemas', () => {
  it('every ContinenteMcp and CartWriter call sends arguments the tool accepts', async () => {
    const replay = new Replay({ get_session_status: 'get_session_status.authenticated' });
    const mcp = new ContinenteMcp(new TestModeGuard(replay, () => false));
    const cart = new CartWriter(mcp, () => false);
    await mcp.searchProducts({ query: 'leite', limit: 5, favoritesFirst: true });
    await mcp.getProduct('2000001');
    await mcp.getProductLabels(['2000001']);
    await mcp.chooseProducts([{ question: 'leite', productIds: ['2000001', '2000002'], suggested: '2000001' }]);
    await mcp.listFavorites(true);
    await mcp.getCart();
    await mcp.previewCartChanges([{ productId: '2000001', quantity: 2 }]);
    await mcp.listOrders({ limit: 5, includeLines: true });
    await mcp.getOrder('order-0001');
    await mcp.listFrequentlyBought({ orderLimit: 10, limit: 20 });
    await mcp.getSessionStatus();
    await cart.addItem('2000001', 1);
    await cart.setQuantity('2000001', 3, 'line-a1');
    await cart.removeItem('2000001');
    await cart.clearCart();
    const sent = new Set(replay.calls.map(c => c.name));
    expect([...sent].sort()).toEqual([...ALLOWED_TOOLS].sort());
    for (const c of replay.calls) {
      const validate = validator(c.name, 'inputSchema');
      expect(validate(c.args), `${c.name}: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    }
  });
});

describe('session tracking and test mode on recorded results', () => {
  it('ContinenteMcp flags the session invalid on not_authenticated and valid again on success', async () => {
    const replay = new Replay({ get_cart: 'get_cart.not_authenticated' });
    const mcp = new ContinenteMcp(replay);
    const seen: boolean[] = [];
    mcp.on('session', v => seen.push(v));
    await mcp.getCart();
    expect(mcp.sessionValid).toBe(false);
    await mcp.searchProducts({ query: 'leite' });
    expect(seen).toEqual([false, true]);
  });
  it('an upstream error that is not about the session keeps the session state', async () => {
    const mcp = new ContinenteMcp(new Replay({ get_product: 'get_product.not_found' }));
    await mcp.getCart();
    await mcp.getProduct('2000099');
    expect(mcp.sessionValid).toBe(true);
  });
  it('test mode never reaches the real cart tools', async () => {
    const replay = new Replay({});
    const guard = new TestModeGuard(replay, () => true);
    for (const t of MUTATING_TOOLS) await expect(guard.callTool(t, {})).rejects.toBeInstanceOf(MutationBlockedError);
    const cart = new CartWriter(new ContinenteMcp(guard), () => true);
    expect(up.mutationOutcome(await cart.setQuantity('2000001', 2))).toBe('simulated');
    expect(replay.calls).toEqual([]);
  });
});
