import type { CartApi } from '../basket.js';
import type { CatalogReader } from '../catalog.js';

/** Optional capabilities a connector may declare; the app hides features a connector lacks (decision 62). */
export type OptionalCapability = 'promotions' | 'purchase_history' | 'barcode_lookup';
export const OPTIONAL_CAPABILITIES: readonly OptionalCapability[] = ['promotions', 'purchase_history', 'barcode_lookup'];

/**
 * A supermarket plugin. Mandatory: product search (catalog), cart read/add (cart) and a session with its own login.
 * The common core (list, preferences, preview, cart orchestration) never talks to a supermarket directly.
 */
export interface Connector {
  id: string;
  /** Display name; a brand, so not translated. */
  name: string;
  capabilities: readonly OptionalCapability[];
  catalog: CatalogReader;
  cart: CartApi;
  sessionValid: () => boolean | null;
}

/** Public description returned by GET /api/v1/connectors. */
export interface ConnectorInfo { id: string; name: string; capabilities: OptionalCapability[]; session_valid: boolean | null }

export const describe = (c: Connector): ConnectorInfo => ({ id: c.id, name: c.name, capabilities: [...c.capabilities], session_valid: c.sessionValid() });
