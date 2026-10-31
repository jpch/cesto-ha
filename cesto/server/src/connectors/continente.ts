import type { CartApi } from '../basket.js';
import type { CatalogReader } from '../catalog.js';
import type { Connector } from './types.js';

/** Continente.pt via the unofficial continentept-mcp (search, cart, session, plus every optional capability). */
export function continenteConnector(catalog: CatalogReader, cart: CartApi, sessionValid: () => boolean | null): Connector {
  return { id: 'continente', name: 'Continente', capabilities: ['promotions', 'purchase_history', 'barcode_lookup'], catalog, cart, sessionValid };
}
