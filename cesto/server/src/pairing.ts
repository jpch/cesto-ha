import qrcode from 'qrcode-generator';

export class PairingError extends Error { constructor(readonly key: string) { super(key); } }

/** Port of the add-on API; used when the pairing address has none, so the QR code never points the app at port 80. */
export const ADDON_PORT = 8099;

/**
 * Address the phone uses on the home network: http(s), host and port, no path, query or credentials.
 * Entered by the admin on the add-on page (never hardcoded). Without a scheme http is assumed; without a port the
 * add-on port 8099 is used. An explicit port, including the scheme default, is kept as typed.
 */
export function normaliseAddress(input: unknown): string {
  if (typeof input !== 'string' || input.length > 200) throw new PairingError('error.invalid_address');
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { throw new PairingError('error.invalid_address'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new PairingError('error.invalid_address');
  // URL drops a port equal to the scheme default (http://h:80 -> port ''), so read the typed authority as well.
  const authority = text.slice(text.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  const typedPort = /:(\d+)$/.exec(authority)?.[1];
  const port = url.port || (typedPort ? String(Number(typedPort)) : String(ADDON_PORT));
  return `${url.protocol}//${url.hostname}:${port}`;
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
