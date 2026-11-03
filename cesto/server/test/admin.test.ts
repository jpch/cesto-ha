import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { LoginService } from '../src/login.js';
import { testConfig } from './helpers.js';

const LINK = { available: true, url_source: 'discovered', addon_slug: '75545ee1_continente_mcp', version: '1.0.0', session_valid: true, signing_in: false, credentials_configured: true, token: 'approved', fingerprint: 'ABCD-1234', checked_at: null } as const;

function setup(continente?: () => typeof LINK) {
  const dataDir = mkdtempSync(join(tmpdir(), 'admin-'));
  const db = openDatabase(':memory:');
  const app = buildApp({ config: testConfig({ dataDir }), db, version: '0.1.0', continente, checkSession: async () => true });
  return { app, db, dataDir };
}

describe('admin page API', () => {
  it('reports status with test mode and the Continente MCP link', async () => {
    expect((await setup().app.inject('/api/v1/admin/status')).json()).toMatchObject({ test_mode: true, language: 'pt-PT', credentials: { configured: false, email: null }, login: { state: 'idle' }, continente: null });
    const s = (await setup(() => LINK).app.inject('/api/v1/admin/status')).json();
    expect(s.continente).toEqual(LINK);
    expect(s.credentials).toEqual({ configured: true, email: null });
    expect(JSON.stringify(s)).not.toMatch(/cmcp_/);
  });

  it('2.0.0: account and sign-in routes answer 410 moved; GET login keeps its shape', async () => {
    const { app } = setup(() => ({ ...LINK, signing_in: true }));
    for (const [method, url] of [['PUT', '/api/v1/admin/credentials'], ['DELETE', '/api/v1/admin/credentials'], ['POST', '/api/v1/admin/login'], ['DELETE', '/api/v1/admin/login']] as const) {
      const res = await app.inject({ method, url, payload: method === 'PUT' ? { email: 'user@example.org', password: 'x' } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(410);
      expect(res.json().error.message_key).toBe('error.moved_to_continente_mcp');
    }
    expect((await app.inject('/api/v1/admin/login')).json()).toEqual({ state: 'waiting_user', started_at: null, available: false });
    expect((await app.inject('/vnc/vnc.html')).statusCode).toBe(404);
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
    for (const url of ['/', '/web/app.js', '/api/v1/admin/export', '/api/v1/admin/status'])
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
    for (const state of ['option', 'pending_approval', 'approved', 'rejected']) used.push(`continente.token_${state}`);
    for (const key of used) expect(pt[key], key).toBeTruthy();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text).toBe('');
  });

  it('every message key the server can return is translated', () => {
    const src = ['app.ts', 'web.ts'].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
    const adminKeys = ['error.moved_to_continente_mcp', 'error.continente_unavailable', 'error.invalid_token_request', 'error.token_not_found', 'error.admin_ingress_only'];
    for (const k of adminKeys) { expect(src).toContain(k); expect(pt[k], k).toBeTruthy(); }
  });
});
