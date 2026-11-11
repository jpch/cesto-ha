/**
 * Shared by the contract tests: the reviewed continentept-mcp snapshots Cesto supports, the recorded
 * fixtures, and the calls Cesto makes. No Continente login, no network.
 */
import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ToolResult } from '../../src/mcp/tools.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from '../../src/mcp/continente.js';
import type { McpTransport } from '../../src/mcp/client.js';
import type { SnapshotTool } from './snapshot.mjs';

export interface Snapshot { package: string; version: string; tools: SnapshotTool[] }
const dir = new URL('./', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

/** The current snapshot (the version the Continente MCP add-on pins once updated). */
export const snapshot = json('upstream-tools.json') as Snapshot;
/**
 * Every continentept-mcp version Cesto reads: the current snapshot plus the older ones kept as
 * `upstream-tools-<version>.json` so Cesto keeps working with an add-on that still pins them.
 */
export const SNAPSHOTS: Snapshot[] = [snapshot, ...readdirSync(dir)
  .filter(f => /^upstream-tools-\d+\.\d+\.\d+\.json$/.test(f)).sort().map(f => json(f) as Snapshot)];
export const snapshotFor = (version: string) => SNAPSHOTS.find(s => s.version === version);

export const FIXTURES = readdirSync(new URL('fixtures/', dir)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
export const raw = (name: string) => readFileSync(new URL(`fixtures/${name}.json`, dir), 'utf8');
/** The ToolResult HttpMcpTransport returns: structuredContent.result. */
export const fx = (name: string) => (JSON.parse(raw(name)) as { result: ToolResult }).result;

/** Fixtures recorded from a newer version than some kept snapshots: name → first version that can produce it. */
export const FIXTURE_SINCE: Record<string, string> = {
  // 0.13.0: an unconfirmed cart change may point at list_coupons for recovery (Cesto never calls it).
  'set_cart_item_quantity.unknown_coupons': '0.13.0',
};
const num = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
export const fixturesFor = (version: string) => FIXTURES.filter(f => !FIXTURE_SINCE[f] || num(version) >= num(FIXTURE_SINCE[f]));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
export function validator(snap: Snapshot, name: string, kind: 'inputSchema' | 'outputSchema') {
  const t = snap.tools.find(x => x.name === name);
  if (!t) throw new Error(`${name} is not in continentept-mcp ${snap.version}`);
  return ajv.compile(t[kind] as object);
}

/** Replays fixtures by tool name and records every call. */
export class Replay implements McpTransport {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly answers: Record<string, string>) {}
  async callTool(name: string, args: Record<string, unknown>) { this.calls.push({ name, args }); return fx(this.answers[name] ?? `${name}.success`); }
  async close() {}
}

/** Every call ContinenteMcp and CartWriter can make, with the arguments Cesto sends. */
export async function cestoCalls() {
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
  return replay.calls;
}
