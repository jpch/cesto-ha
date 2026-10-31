import { randomUUID } from 'node:crypto';
import { thumbnailUrl } from './thumbnails.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokens, type CatalogReader, type Product } from './catalog.js';
import { productsOf } from './mcp/upstream.js';

/** A vision provider turns an image into search hints. Only `none` exists in v1: no image ever leaves the server. */
export interface VisionProvider { readonly name: string; describe(image: Buffer): Promise<string[]> }
export const noneProvider: VisionProvider = { name: 'none', async describe() { return []; } };
export function createProvider(name: string): VisionProvider {
  if (name === 'none') return noneProvider;
  throw new Error(`unknown vision provider: ${name}`);
}

export class PhotoError extends Error { constructor(readonly status: number, readonly key: string) { super(key); } }
export interface Candidate { product_id: string; name: string; package_text: string | null; image_url: string | null; thumbnail_url: string | null; availability: string }
export interface PhotoResult { photo_id: string; source: 'barcode' | 'text' | 'vision' | 'none'; query: string | null; candidates: Candidate[]; thumbnail: boolean }
export interface PhotoInput { barcode?: unknown; text?: unknown; image_base64?: unknown; thumbnail_base64?: unknown }

const MAX_THUMB = 64 * 1024;
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const validEan = (code: string) => {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const d = code.split('').map(Number); const check = d.pop()!;
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};
/** Packaging OCR text -> a short search query: the most distinctive words, no numbers-only noise. */
export function textQuery(text: string): string {
  const seen = new Set<string>();
  const words = text.split(/[\s,;:()/|]+/).map(w => w.trim()).filter(w => w.length > 2 && /\p{L}/u.test(w) && w.length < 30);
  const out: string[] = [];
  for (const w of words) { const k = tokens(w).join(' '); if (k && !seen.has(k)) { seen.add(k); out.push(w); } if (out.length === 5) break; }
  return out.join(' ');
}

/**
 * Photo identification: barcode (EAN read on the phone) first, then packaging text (OCR on the phone),
 * then the configured vision provider. The original image is only held in memory and wiped; only an
 * optional small thumbnail sent by the app is kept until the photo is deleted.
 */
export class PhotoService {
  private readonly dir: string;
  constructor(dataDir: string, private readonly catalog: CatalogReader, private readonly provider: VisionProvider = noneProvider) {
    this.dir = join(dataDir, 'photos');
  }

  async identify(input: PhotoInput): Promise<PhotoResult> {
    const { barcode, text, image_base64, thumbnail_base64 } = input;
    if (barcode !== undefined && (typeof barcode !== 'string' || !validEan(barcode))) throw new PhotoError(400, 'error.invalid_barcode');
    if (text !== undefined && (typeof text !== 'string' || text.length > 2000)) throw new PhotoError(400, 'error.invalid_text');
    let thumb: Buffer | undefined;
    if (thumbnail_base64 !== undefined) {
      if (typeof thumbnail_base64 !== 'string') throw new PhotoError(400, 'error.invalid_thumbnail');
      thumb = Buffer.from(thumbnail_base64, 'base64');
      if (thumb.length > MAX_THUMB || !(isJpeg(thumb) || isPng(thumb))) throw new PhotoError(400, 'error.invalid_thumbnail');
    }
    if (barcode === undefined && !text && image_base64 === undefined) throw new PhotoError(400, 'error.nothing_to_identify');

    const id = randomUUID();
    let result: PhotoResult = { photo_id: id, source: 'none', query: null, candidates: [], thumbnail: !!thumb };
    if (barcode) result = { ...result, source: 'barcode', query: barcode, candidates: await this.search(barcode, 1) };
    if (!result.candidates.length && typeof text === 'string' && text.trim()) {
      const q = textQuery(text);
      if (q) result = { ...result, source: 'text', query: q, candidates: await this.search(q, 5) };
    }
    if (!result.candidates.length && typeof image_base64 === 'string') {
      const image = Buffer.from(image_base64, 'base64');
      try {
        const hints = this.provider.name === 'none' ? [] : await this.provider.describe(image);
        if (hints.length) result = { ...result, source: 'vision', query: hints.join(' '), candidates: await this.search(hints.join(' '), 5) };
      } finally { image.fill(0); }
    }
    if (thumb) { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); writeFileSync(this.path(id), thumb, { mode: 0o600 }); }
    return result;
  }

  thumbnail(id: string): Buffer | undefined { return this.valid(id) && existsSync(this.path(id)) ? readFileSync(this.path(id)) : undefined; }
  remove(id: string): boolean { if (!this.valid(id) || !existsSync(this.path(id))) return false; rmSync(this.path(id)); return true; }

  private valid(id: string) { return /^[0-9a-f-]{36}$/.test(id); }
  private path(id: string) { return join(this.dir, `${id}.img`); }
  private async search(query: string, limit: number): Promise<Candidate[]> {
    const res = await this.catalog.searchProducts({ query, limit });
    return productsOf(res).slice(0, limit).map(p => ({
      product_id: p.productId, name: p.name, package_text: p.packageText ?? null, image_url: p.imageUrl ?? null, thumbnail_url: thumbnailUrl(p.imageUrl), availability: p.availability ?? 'unknown',
    }));
  }
}
