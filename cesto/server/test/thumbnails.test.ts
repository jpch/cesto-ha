import { describe, expect, it } from 'vitest';
import { thumbnailUrl } from '../src/thumbnails.js';

const IMG = 'https://www.continente.pt/dw/image/v2/BDVS_PRD/on/demandware.static/-/Sites-col-master-catalog/default/dw75836dcc/images/col/773/7739159-frente.jpg?sw=2000&sh=2000';

describe('thumbnailUrl', () => {
  it('asks the store CDN for its small size', () => {
    const t = new URL(thumbnailUrl(IMG)!);
    expect(t.hostname).toBe('www.continente.pt');
    expect(t.searchParams.get('sw')).toBe('120');
    expect(t.searchParams.get('sh')).toBe('120');
    expect(t.pathname).toBe(new URL(IMG).pathname);
  });

  it('adds the size when the store URL has none', () => {
    expect(thumbnailUrl(IMG.split('?')[0])).toMatch(/\?sw=120&sh=120$/);
  });

  it.each([
    null, undefined, '', 'not a url', 'http://www.continente.pt/dw/image/x.jpg',
    'https://evil.example/dw/image/x.jpg', 'https://www.continente.pt.evil.example/x.jpg',
    'https://user:pw@www.continente.pt/dw/image/x.jpg', 'https://www.continente.pt:8443/dw/image/x.jpg',
    'https://127.0.0.1/x.jpg', 'https://homeassistant.local/x.jpg', 'file:///etc/passwd', `https://www.continente.pt/${'a'.repeat(1000)}`,
  ])('refuses %s', url => {
    expect(thumbnailUrl(url as string | null)).toBeNull();
  });
});
