import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createAiClient, type AiClient } from '../src/ai.js';
import { loadConfig } from '../src/config.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { asLan, testConfig } from './helpers.js';

async function setup(ai: AiClient | null) {
  const { catalog, calls } = fixtureCatalog();
  const app = buildApp({ config: testConfig({ testMode: false }), db: openDatabase(':memory:'), version: '0.2.0', catalog, ai });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  asLan(app);
  for (const payload of [{ name: 'Iogurte natural' }, { name: 'Ovos' }, { name: 'Arroz agulha' }, { name: 'Ovos caseiros', category: 'Ovos' }])
    await app.inject({ method: 'POST', url: '/api/v1/lists/current/items', headers, payload });
  return { app, headers, calls };
}

describe('promotion suggestions', () => {
  it('without AI: searches each item category (or name) and keeps only products on promotion', async () => {
    const { app, headers, calls } = await setup(null);
    const res = await app.inject({ url: '/api/v1/promotions', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ source: 'search', provider: 'none', ai_error: null });
    expect(body.suggestions.map((s: { product: { product_id: string } }) => s.product.product_id)).toEqual(['3300001', '7700001']);
    expect(body.suggestions[0]).toMatchObject({ item_name: 'Iogurte natural', reason: null });
    expect(calls.every(c => c.tool === 'search_products')).toBe(true);
    expect(calls.filter(c => c.arg === 'Ovos')).toHaveLength(1); // same query searched once
  });

  it('with AI: only candidates from the search survive, with the reason', async () => {
    const ai: AiClient = { name: 'openai', async completeJson() {
      return { suggestions: [{ item_id: 2, product_id: '7700001', reason: 'Leve 2, poupa 50% na segunda.' }, { item_id: 1, product_id: '999', reason: 'invented' }] };
    } };
    const t = await setup(ai);
    const body = (await t.app.inject({ url: '/api/v1/promotions', headers: t.headers })).json();
    expect(body.source).toBe('ai');
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({ item_id: 2, reason: 'Leve 2, poupa 50% na segunda.', product: { product_id: '7700001' } });
  });

  it('falls back to the search when the AI fails', async () => {
    const ai: AiClient = { name: 'anthropic', async completeJson() { throw new Error('boom'); } };
    const t = await setup(ai);
    const body = (await t.app.inject({ url: '/api/v1/promotions', headers: t.headers })).json();
    expect(body).toMatchObject({ source: 'search', provider: 'anthropic', ai_error: 'error.ai_failed' });
    expect(body.suggestions).toHaveLength(2);
  });

  it('AI config: default none, no client without a key, OpenAI request shape', async () => {
    expect(loadConfig({ OPTIONS_PATH: '/nonexistent.json' }).ai).toEqual({ provider: 'none', apiKey: null, model: null });
    expect(createAiClient({ provider: 'openai', apiKey: null, model: null })).toBeNull();
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => { seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"suggestions":[]}\n```' } }] })); }) as unknown as typeof fetch;
    const client = createAiClient({ provider: 'openai', apiKey: 'sk-test', model: null }, fake)!;
    expect(await client.completeJson('s', 'u')).toEqual({ suggestions: [] });
    expect(seen!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });
});

const ADDON_CONFIG = new URL('../../config.yaml', import.meta.url);

describe('version', () => {
  it('openapi.yaml documents the server version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as { info: { version: string } };
    expect(spec.info.version).toBe(pkg.version);
  });

  // config.yaml is outside the Docker build context; this runs in the repository checkout.
  it.skipIf(!existsSync(ADDON_CONFIG))('health reports the add-on version from config.yaml (package.json kept in sync)', () => {
    const addon = parse(readFileSync(ADDON_CONFIG, 'utf8')) as { version: string };
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe(addon.version);
  });
});
