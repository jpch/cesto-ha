import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { asLan, testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';

/** Long matching runs (many items, slow Chromium) must not depend on the phone's 30 s read timeout. */
async function setup(gate?: Promise<void>, fail = false) {
  const db = openDatabase(':memory:');
  const { catalog } = fixtureCatalog({ frequent: ['4421406'] });
  const runJob = async <T>(job: () => Promise<T>) => { await gate; if (fail) throw new Error('chromium crashed'); return job(); };
  const app = buildApp({ config: testConfig(), db, version: '0.1.0', catalog, runJob });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  asLan(app);
  return { app, headers };
}
const add = (app: Awaited<ReturnType<typeof setup>>['app'], headers: object, name: string) =>
  app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload: { name } });

describe('async proposals', () => {
  it('returns 202 at once, reports progress, then the ready proposal under the same id', async () => {
    let open!: () => void;
    const { app, headers } = await setup(new Promise<void>(r => { open = r; }));
    await add(app, headers, 'leite'); await add(app, headers, 'iogurtes');
    const res = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { async: true } });
    expect(res.statusCode).toBe(202);
    const { proposal_id, status } = res.json();
    expect(status).toBe('matching');
    const again = await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { async: true } });
    expect(again.json().proposal_id).toBe(proposal_id); // a retry joins the running match
    const polling = await app.inject({ url: `/api/v1/basket/proposals/${proposal_id}`, headers });
    expect(polling.statusCode).toBe(202);
    expect(polling.json()).toMatchObject({ status: 'matching', progress: { done: 0 } });
    open();
    await new Promise(r => setTimeout(r, 20));
    const ready = await app.inject({ url: `/api/v1/basket/proposals/${proposal_id}`, headers });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ proposal_id, status: 'ready' });
    expect(ready.json().lines).toHaveLength(2);
  });

  it('a failed run reports its cause; nothing pending is an immediate 409', async () => {
    const { app, headers } = await setup(undefined, true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { async: true } })).statusCode).toBe(409);
    await add(app, headers, 'leite');
    const { proposal_id } = (await app.inject({ method: 'POST', url: '/api/v1/basket/proposals', headers, payload: { async: true } })).json();
    await new Promise(r => setTimeout(r, 20));
    const r = await app.inject({ url: `/api/v1/basket/proposals/${proposal_id}`, headers });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'failed', error: { message_key: 'error.mcp_unavailable' } });
  });
});
