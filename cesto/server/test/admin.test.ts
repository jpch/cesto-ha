import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { LoginService } from '../src/login.js';
import { testConfig } from './helpers.js';

const node = (code: string) => ({ command: process.execPath, args: ['-e', code] });
const fakeLogin = (loginCode: string, timeoutMs = 5000) => new LoginService({
  display: node('setInterval(() => {}, 1000)'), websockify: node('setInterval(() => {}, 1000)'),
  login: node(loginCode), env: {}, displayDelayMs: 10, timeoutMs,
});
const waitFor = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 25)); };

function setup(login?: LoginService) {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  const db = openDatabase(':memory:');
  let restarts = 0;
  const app = buildApp({ config: testConfig({ dataDir }), db, version: '0.1.0', login, onCredentialsChanged: () => { restarts++; }, checkSession: async () => true });
  return { app, db, dataDir, restarts: () => restarts };
}

describe('admin page API', () => {
  it('reports status with test mode and no saved account', async () => {
    const { app } = setup();
    const s = (await app.inject('/api/v1/admin/status')).json();
    expect(s).toMatchObject({ test_mode: true, language: 'pt-PT', credentials: { configured: false, email: null }, login: { state: 'idle' } });
  });

  it('saves the account to a 0600 file, never returns the password, and restarts the MCP', async () => {
    const { app, dataDir, restarts } = setup();
    const secret = 'S3gr3do!x';
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/credentials', payload: { email: 'user@example.org', password: secret } })).statusCode).toBe(204);
    const file = join(dataDir, 'continente', 'credentials.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'continente')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toContain("CONTINENTE_EMAIL='user@example.org'");
    const status = await app.inject('/api/v1/admin/status');
    expect(status.body).not.toContain(secret);
    expect(status.json().credentials).toEqual({ configured: true, email: 'us…@example.org' });
    expect(restarts()).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/credentials' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/credentials' })).statusCode).toBe(404);
  });

  it('rejects invalid account input with message keys', async () => {
    const { app } = setup();
    for (const [payload, key] of [[{ email: 'nope', password: 'x' }, 'error.invalid_email'], [{ email: 'user@example.org', password: '' }, 'error.invalid_password'], [{ email: 'user@example.org', password: "a'b" }, 'error.invalid_password'], [{ email: 'user@example.org', password: 'a\nCONTINENTE_EMAIL=x' }, 'error.invalid_password']] as const) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/admin/credentials', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message_key).toBe(key);
    }
  });

  it('sign-in needs a saved account, then runs display + noVNC + login and reports success', async () => {
    const login = fakeLogin('setTimeout(() => process.exit(0), 100)');
    const { app } = setup(login);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/login' })).statusCode).toBe(409);
    await app.inject({ method: 'PUT', url: '/api/v1/admin/credentials', payload: { email: 'user@example.org', password: 'pw' } });
    let succeeded = false;
    login.on('success', () => { succeeded = true; });
    const started = await app.inject({ method: 'POST', url: '/api/v1/admin/login' });
    expect(started.statusCode).toBe(202);
    expect(started.json().state).toBe('starting');
    await waitFor(() => login.state === 'succeeded');
    expect(succeeded).toBe(true);
    expect((await app.inject('/api/v1/admin/login')).json().state).toBe('succeeded');
  });

  it('sign-in reports failure, timeout and cancel', async () => {
    const failing = fakeLogin('process.exit(3)');
    failing.start();
    await waitFor(() => failing.state === 'failed');
    expect(failing.state).toBe('failed');
    const slow = fakeLogin('setInterval(() => {}, 1000)', 200);
    slow.start();
    await waitFor(() => slow.state === 'timed_out');
    expect(slow.state).toBe('timed_out');
    const cancelled = fakeLogin('setInterval(() => {}, 1000)');
    cancelled.start();
    cancelled.cancel();
    expect(cancelled.state).toBe('cancelled');
  });

  it('noVNC is only proxied while a sign-in is open', async () => {
    const { app } = setup(fakeLogin('process.exit(0)'));
    expect((await app.inject('/vnc/vnc.html')).statusCode).toBe(409);
  });

  it('session check and JSON export', async () => {
    const { app, db } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/session/check' })).json()).toEqual({ session_valid: true });
    db.prepare("INSERT INTO lists (name, created_at, updated_at) VALUES ('L', 'x', 'x')").run();
    db.prepare("INSERT INTO items (list_id, name, added_by, created_at, updated_at, version) VALUES (1, 'Leite', 'Ana', 'x', 'x', 1)").run();
    const res = await app.inject('/api/v1/admin/export');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="cesto-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = res.json();
    expect(data).toMatchObject({ format: 'cesto-export', format_version: 2, lists: [{ name: 'L', items: [{ name: 'Leite', added_by: 'Ana' }] }], runs: [], preferences: [] });
    expect(res.body).not.toMatch(/token_hash|PASSWORD/);
  });

  it('serves the web page through ingress only', async () => {
    const { app } = setup();
    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect((await app.inject('/web/i18n/pt-PT.json')).statusCode).toBe(200);
    expect((await app.inject('/web/../src/app.ts')).statusCode).toBe(404);
    for (const url of ['/', '/web/app.js', '/vnc/vnc.html', '/api/v1/admin/export', '/api/v1/admin/status'])
      expect((await app.inject({ url, remoteAddress: '192.0.2.50' })).statusCode, url).toBe(403);
  });
});

describe('web i18n', () => {
  const web = (f: string) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
  const pt = JSON.parse(web('i18n/pt-PT.json')) as Record<string, string>;
  const en = JSON.parse(web('i18n/en.json')) as Record<string, string>;

  it('pt-PT and en have the same keys and no empty strings', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
    expect(Object.values(pt).every(Boolean) && Object.values(en).every(Boolean)).toBe(true);
  });

  it('every key used by the page exists, and the HTML has no hardcoded text', () => {
    const html = web('index.html');
    const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]!);
    const js = web('app.js');
    used.push(...[...js.matchAll(/tr\('([a-z_.]+)'/g)].map(m => m[1]!));
    for (const state of ['idle', 'starting', 'waiting_user', 'succeeded', 'failed', 'timed_out', 'cancelled']) used.push(`login.state.${state}`);
    for (const key of used) expect(pt[key], key).toBeTruthy();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text).toBe('');
  });

  it('every message key the server can return is translated', () => {
    const src = ['app.ts', 'credentials.ts', 'web.ts'].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
    const adminKeys = ['error.invalid_email', 'error.invalid_password', 'error.credentials_missing', 'error.login_unavailable', 'error.invalid_token_request', 'error.token_not_found', 'error.admin_ingress_only'];
    for (const k of adminKeys) { expect(src).toContain(k); expect(pt[k], k).toBeTruthy(); }
  });
});
