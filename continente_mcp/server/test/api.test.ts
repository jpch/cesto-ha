import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('API core', () => {
  it('serves /health without auth', async () => {
    const { app } = makeApp();
    const res = await app.inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: '0.1.0', test_mode: true, session_valid: null, queue_length: 0 });
  });

  it('rejects unauthenticated and bad-token calls with 401 and a message key', async () => {
    const { app } = makeApp();
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Basic x' }]) {
      const res = await app.inject({ url: '/api/v1/me', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized', message_key: 'error.unauthorized' } });
    }
  });

  it('creates, uses and revokes a token via ingress-only admin routes', async () => {
    const { app } = makeApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Alex phone', kind: 'phone' } });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^cmh_/);
    const me = await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toMatchObject({ id, name: 'Alex phone', kind: 'phone' });
    const list = await app.inject('/api/v1/admin/tokens');
    expect(JSON.stringify(list.json())).not.toContain(token);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/tokens/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it('blocks admin routes from outside the HA ingress', async () => {
    const { app } = makeApp({ ingressAddress: '172.30.32.2' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'x', kind: 'app' } });
    expect(res.statusCode).toBe(403);
  });

  it('validates token creation input', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: '', kind: 'robot' } });
    expect(res.statusCode).toBe(400);
  });
});
