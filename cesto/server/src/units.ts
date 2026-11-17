/**
 * Unit prices an app can show. continentept-mcp 0.14.0+ prices detergents per dose (`per: "dose"`); Cesto apps
 * before 1.x-dose (no `X-Cesto-Units` header) only know kg and litre and would show "€/kg" for a dose.
 *
 * Apps that read other units say so with `X-Cesto-Units: kg,l,dose`. For any other client, every API response
 * is rewritten before it is sent: a unit price in a unit the client does not list becomes null, a related
 * cheaper product compared in such a unit is left out, and a comparison basis in such a unit becomes null. Prices
 * themselves (`price`, with its own `per`) are untouched: old apps do not read their unit.
 */
export const UNITS_HEADER = 'x-cesto-units';
/** The units every Cesto app has always shown. */
export const BASE_UNITS: readonly string[] = ['kg', 'l'];
/** The units this add-on can send. */
export const KNOWN_UNITS: readonly string[] = ['kg', 'l', 'dose'];

/** The unit-price units a request says its client shows (always at least kg and l). */
export function clientUnits(header: unknown): Set<string> {
  const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
  const units = new Set(BASE_UNITS);
  for (const u of raw.slice(0, 200).split(',')) { const v = u.trim().toLowerCase(); if (KNOWN_UNITS.includes(v)) units.add(v); }
  return units;
}

/** True when the client shows every unit this add-on can send (no rewrite needed). */
export const showsAll = (units: Set<string>) => KNOWN_UNITS.every(u => units.has(u));

const UNIT_KEYS = new Set(['unit_price', 'unitPrice']);
const unitOf = (v: unknown): string | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of UNIT_KEYS) {
    const u = o[k];
    if (u && typeof u === 'object' && typeof (u as { per?: unknown }).per === 'string') return (u as { per: string }).per;
  }
  return null;
};
const unknownUnit = (v: unknown, units: Set<string>) => { const per = unitOf(v); return per !== null && !units.has(per); };

/** Returns `payload` with unit prices outside `units` removed (see above). The input is not modified. */
export function forUnits<T>(payload: T, units: Set<string>, depth = 0): T {
  if (depth > 40 || payload === null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(x => forUnits(x, units, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (UNIT_KEYS.has(k) && v && typeof v === 'object' && typeof (v as { per?: unknown }).per === 'string' && !units.has((v as { per: string }).per)) out[k] = null;
    else if (k === 'cheaper' && Array.isArray(v)) out[k] = v.filter(x => !unknownUnit(x, units)).map(x => forUnits(x, units, depth + 1));
    else if (k === 'basis' && unknownUnit(v, units)) out[k] = null;
    else out[k] = forUnits(v, units, depth + 1);
  }
  return out as T;
}
