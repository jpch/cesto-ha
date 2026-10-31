import qrcode from 'qrcode-generator';

export class PairingError extends Error { constructor(readonly key: string) { super(key); } }

/**
 * Address the phone uses on the home network: http(s), host and optional port, no path, query or credentials.
 * Entered by the admin on the add-on page (never hardcoded).
 */
export function normaliseAddress(input: unknown): string {
  if (typeof input !== 'string' || input.length > 200) throw new PairingError('error.invalid_address');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new PairingError('error.invalid_address'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new PairingError('error.invalid_address');
  return url.origin;
}

/** cesto://pair link read by the app's QR scanner (decision 67). */
export const pairingUri = (address: string, token: string, slug?: string | null) =>
  `cesto://pair?address=${encodeURIComponent(address)}&token=${encodeURIComponent(token)}${slug ? `&slug=${encodeURIComponent(slug)}` : ''}`;

/** QR code as a self-contained SVG (no external requests). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
