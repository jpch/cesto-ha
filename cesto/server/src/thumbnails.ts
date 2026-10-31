/**
 * Small product images for the app's candidate lists. The add-on never fetches or proxies images: it only
 * rewrites the store's own image URL to the store's small size, and only for allowlisted store image hosts,
 * so a malformed or hostile `imageUrl` from a connector can never point the app at another host.
 */

/** Store image hosts per connector; only these get a thumbnail URL. */
export const THUMBNAIL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  continente: ['www.continente.pt'],
};

/** Edge, in pixels, of the requested square thumbnail (40 dp at up to 3x density). */
export const THUMBNAIL_PX = 120;

const ALLOWED = new Set(Object.values(THUMBNAIL_HOSTS).flat());

/**
 * Thumbnail URL for a store image, or null when the URL is not https, not on an allowlisted host, carries
 * credentials or a non-default port. Salesforce Commerce Cloud image paths (`/dw/image/`) are resized by
 * the store's CDN through the `sw`/`sh` parameters.
 */
export function thumbnailUrl(imageUrl: string | null | undefined): string | null {
  if (typeof imageUrl !== 'string' || imageUrl.length > 1000) return null;
  let url: URL;
  try { url = new URL(imageUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED.has(url.hostname)) return null;
  url.hash = '';
  if (url.pathname.startsWith('/dw/image/')) {
    url.searchParams.set('sw', String(THUMBNAIL_PX));
    url.searchParams.set('sh', String(THUMBNAIL_PX));
  }
  return url.toString();
}
