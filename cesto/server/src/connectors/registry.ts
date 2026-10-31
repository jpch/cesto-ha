/** Connector ids the add-on knows; `connectors` in the add-on options picks which are enabled. */
export const KNOWN_CONNECTORS = ['continente'] as const;
export type ConnectorId = (typeof KNOWN_CONNECTORS)[number];

export const CONNECTOR_NAMES: Record<ConnectorId, string> = { continente: 'Continente' };

/** Enabled connector ids from the options: known ids only, de-duplicated, default Continente. */
export function enabledConnectors(raw: unknown): ConnectorId[] {
  if (!Array.isArray(raw)) return ['continente'];
  const ids = [...new Set(raw.filter((v): v is ConnectorId => typeof v === 'string' && (KNOWN_CONNECTORS as readonly string[]).includes(v)))];
  return ids.length ? ids : ['continente'];
}
