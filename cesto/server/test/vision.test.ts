import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createProvider, textQuery } from '../src/vision.js';
import { asLan, testConfig } from './helpers.js';
import { fixtureCatalog } from './fixtures/catalog.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const IMAGE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400_000, 9)]);

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'photos-'));
  const { catalog, calls } = fixtureCatalog();
  const search = catalog.searchProducts.bind(catalog);
  // The account's search resolves EAN codes; emulate one.
  catalog.searchProducts = args => search(args.query === '5601312049043' ? { ...args, query: 'Mimosa' } : args);
  const app = buildApp({ config: testConfig({ dataDir }), db: openDatabase(':memory:'), version: '0.1.0', catalog });
  const token = (await app.inject({ method: 'POST', url: '/api/v1/admin/tokens', payload: { name: 'Ana', kind: 'phone' } })).json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  asLan(app);
  const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/photos', headers, payload });
  return { app, headers, post, calls, dataDir };
}

describe('photo identification', () => {
  it('barcode path: one search by EAN, thumbnail kept, photo deletable', async () => {
    const t = await setup();
    const res = await t.post({ barcode: '5601312049043', thumbnail_base64: JPEG.toString('base64') });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ source: 'barcode', thumbnail: true });
    expect(r.candidates[0].product_id).toBe('4421406');
    const thumb = await t.app.inject({ url: `/api/v1/photos/${r.photo_id}/thumbnail`, headers: t.headers });
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(thumb.rawPayload.equals(JPEG)).toBe(true);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/photos/${r.photo_id}`, headers: t.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/v1/photos/${r.photo_id}/thumbnail`, headers: t.headers })).statusCode).toBe(404);
  });

  it('packaging text path when the barcode is unknown', async () => {
    const t = await setup();
    const r = (await t.post({ barcode: '4006381333931', text: 'IOGURTE\nGrego Natural\nOikos 4x110g 0% gordura' })).json();
    expect(r.source).toBe('text');
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(5);
    expect(r.candidates.some((c: { name: string }) => c.name.includes('Oikos'))).toBe(true);
  });

  it("with provider 'none' no image leaves the server and the original is never persisted", async () => {
    const t = await setup();
    const r = (await t.post({ image_base64: IMAGE.toString('base64'), thumbnail_base64: JPEG.toString('base64') })).json();
    expect(r).toMatchObject({ source: 'none', candidates: [] });
    expect(t.calls).toHaveLength(0);
    const files = readdirSync(join(t.dataDir, 'photos'));
    expect(files).toEqual([`${r.photo_id}.img`]);
    expect((await t.app.inject({ url: `/api/v1/photos/${r.photo_id}/thumbnail`, headers: t.headers })).rawPayload.length).toBe(JPEG.length);
  });

  it('rejects invalid input', async () => {
    const t = await setup();
    expect((await t.post({ barcode: '5601312049045' })).statusCode).toBe(400);
    expect((await t.post({})).statusCode).toBe(400);
    expect((await t.post({ text: 'x', thumbnail_base64: Buffer.alloc(100).toString('base64') })).statusCode).toBe(400);
    expect((await t.app.inject({ url: '/api/v1/photos/../../etc/thumbnail', headers: t.headers })).statusCode).toBeOneOf([403, 404]);
    expect(existsSync(join(t.dataDir, 'photos'))).toBe(false);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/photos', payload: { text: 'leite' } })).statusCode).toBe(401);
  });

  it('only the none provider exists', () => {
    expect(createProvider('none').name).toBe('none');
    expect(() => createProvider('openai')).toThrow();
    expect(textQuery('500 g | Arroz Agulha, Cigala; 1kg 2024')).toBe('Arroz Agulha Cigala 1kg');
  });
});
