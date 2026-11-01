import { describe, expect, it } from 'vitest';
import { buildApp, REMOTE_ROUTE, SESSION_CHECK_MIN_MS, SessionChecks } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { testConfig } from './helpers.js';

const INGRESS = '172.30.32.2';
const ha = { 'x-remote-user-id': 'u1', 'x-remote-user-name': 'alex', 'x-remote-user-display-name': 'Alex' };

describe('app session check (1.8.0)', () => {
  it('coalesces concurrent checks and caches for the minimum interval', async () => {
    let t = 1_000_000;
    let calls = 0;
    let release: (v: boolean) => void = () => {};
    const checks = new SessionChecks(() => { calls++; return new Promise<boolean>(r => { release = r; }); }, () => t);
    const a = checks.check();
    const b = checks.check();
    release(true);
    expect((await a).session_valid).toBe(true);
    expect((await b).session_valid).toBe(true);
    expect(calls).toBe(1);
    t += SESSION_CHECK_MIN_MS - 1;
    expect(await checks.check()).toMatchObject({ session_valid: true, cached: true });
    expect(calls).toBe(1);
    t += 2;
    const c = checks.check();
    release(false);
    expect(await c).toMatchObject({ session_valid: false, cached: false });
    expect(calls).toBe(2);
  });

  it('a failing check reports null, never throws', async () => {
    const checks = new SessionChecks(() => Promise.reject(new Error('mcp down')));
    expect((await checks.check()).session_valid).toBeNull();
  });

  it('is allowed for tokens and remote HA users, needs auth, and is listed as a remote route', async () => {
    const { catalog } = fixtureCatalog();
    let calls = 0;
    const app = buildApp({
      config: testConfig({ ingressAddress: INGRESS }), db: openDatabase(':memory:'), version: 't', catalog,
      checkSession: async () => { calls++; return true; },
    });
    expect(REMOTE_ROUTE.test('/api/v1/session/check')).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/session/check', remoteAddress: '192.0.2.20' })).statusCode).toBe(401);
    const remote = await app.inject({ method: 'POST', url: '/api/v1/session/check', remoteAddress: INGRESS, headers: ha });
    expect(remote.statusCode).toBe(200);
    expect(remote.json().session_valid).toBe(true);
    // Admin check stays admin-only through ingress.
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/session/check', remoteAddress: INGRESS, headers: { ...ha, 'x-remote-user-groups': 'users' } })).statusCode).toBe(403);
    expect(calls).toBe(1);
  });
});
