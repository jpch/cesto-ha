import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { HaIntegration, listStats } from '../src/ha.js';
import { StdioMcpTransport } from '../src/mcp/client.js';
import { ContinenteMcp, TestModeGuard } from '../src/mcp/continente.js';
import { testConfig } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));
const open: StdioMcpTransport[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(t => t.close())); });

function fakeHa() {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('http://supervisor', '');
    calls.push({ method: init.method!, path, body: init.body ? JSON.parse(init.body as string) : undefined });
    const data = path === '/addons/self/info' ? { result: 'ok', data: { slug: 'a1b2c3d4_cesto' } } : {};
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  const ha = new HaIntegration({ supervisorUrl: 'http://supervisor', token: 'sup-token', language: 'pt-PT', fetchImpl });
  return { ha, calls };
}
const base = { version: '0.1.0', testMode: true, queueLength: 0, pendingItems: 2, totalItems: 3, lastSync: '2026-10-30T00:00:00.000Z' };

describe('Home Assistant integration', () => {
  it('publishes the four entities with the supervisor token', async () => {
    const { ha, calls } = fakeHa();
    await ha.publish({ ...base, sessionValid: true });
    const states = Object.fromEntries(calls.filter(c => c.path.startsWith('/core/api/states/')).map(c => [c.path.slice(17), c.body]));
    expect(Object.keys(states).sort()).toEqual(['binary_sensor.continente_session_valid', 'sensor.continente_last_sync', 'sensor.continente_list_items', 'sensor.continente_server_status']);
    expect(states['sensor.continente_server_status']).toMatchObject({ state: 'test_mode', attributes: { test_mode: true, version: '0.1.0' } });
    expect(states['binary_sensor.continente_session_valid'].state).toBe('on');
    expect(states['sensor.continente_list_items']).toMatchObject({ state: '2', attributes: { total_items: 3 } });
    expect(states['sensor.continente_last_sync']).toMatchObject({ state: base.lastSync, attributes: { device_class: 'timestamp' } });
    expect(calls.some(c => c.path.includes('persistent_notification'))).toBe(false);
  });

  it('a simulated session expiry fires one notification linking to the add-on page, dismissed on recovery', async () => {
    const { ha, calls } = fakeHa();
    const transport = new StdioMcpTransport({ command: process.execPath, args: [FAKE], env: { FAKE_MCP_MODE: 'not_authenticated' } });
    open.push(transport);
    const mcp = new ContinenteMcp(new TestModeGuard(transport, () => true));
    const done: Promise<void>[] = [];
    mcp.on('session', (valid: boolean) => done.push(ha.publish({ ...base, sessionValid: valid })));
    const res = await mcp.getCart();
    expect(res.error?.code).toBe('not_authenticated');
    await Promise.all(done);
    await ha.publish({ ...base, sessionValid: false });
    const created = calls.filter(c => c.path === '/core/api/services/persistent_notification/create');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ notification_id: 'cesto_session_expired', title: 'Sessão Continente expirada' });
    expect(created[0]!.body.message).toContain('(/hassio/ingress/a1b2c3d4_cesto)');
    expect(calls.find(c => c.path.endsWith('binary_sensor.continente_session_valid'))!.body.state).toBe('off');
    await ha.publish({ ...base, sessionValid: true });
    expect(calls.filter(c => c.path === '/core/api/services/persistent_notification/dismiss')).toHaveLength(1);
  });

  it('never throws when Home Assistant is unreachable', async () => {
    const logs: string[] = [];
    const ha = new HaIntegration({ supervisorUrl: 'http://supervisor', token: 't', language: 'en', log: m => logs.push(m),
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(ha.publish({ ...base, sessionValid: false })).resolves.toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('list writes trigger a sensor refresh; reads and parsing do not', async () => {
    const db = openDatabase(':memory:');
    let changed = 0;
    const app = buildApp({ config: testConfig(), db, version: '0.1.0', onListChanged: () => { changed++; } });
    const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token;
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({ url: '/api/v1/lists/current', headers });
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/parse', headers, payload: { text: 'leite' } });
    expect(changed).toBe(0);
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: 'Leite' } });
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name: '' } });
    expect(changed).toBe(1);
    expect(listStats(db)).toMatchObject({ pendingItems: 1, totalItems: 1 });
    expect(listStats(db).lastSync).toMatch(/^\d{4}-/);
  });
});
