/**
 * Shape-only comparison of MCP `tools/list` snapshots (names, input and output schemas; description and title
 * text ignored). Used by the contract tests to compare Cesto's reviewed snapshot with another one, e.g. the
 * snapshot of the continentept-mcp version the Continente MCP add-on pins
 * (jpch/continente-mcp-ha `continente_mcp/server/contract/upstream-tools.json`). The live check against the
 * installed package runs in that add-on, which installs continentept-mcp; Cesto no longer does.
 */

/** Deterministic JSON: object keys sorted, so key order never shows up as a change. */
export const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;

/** Drops human text (description/title strings), keeping only the shape. */
export const shapeOnly = v => Array.isArray(v) ? v.map(shapeOnly)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !(['description', 'title'].includes(k) && typeof x === 'string')).map(([k, x]) => [k, shapeOnly(x)])) : v;

export function normalise(tools) {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name))
    .map(t => canonical(shapeOnly({ name: t.name, inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null })));
}

export function diff(expected, actual) {
  const e = new Map(expected.map(t => [t.name, t]));
  const a = new Map(actual.map(t => [t.name, t]));
  const added = [...a.keys()].filter(n => !e.has(n));
  const removed = [...e.keys()].filter(n => !a.has(n));
  const changed = [...a.keys()].filter(n => e.has(n)).flatMap(n => {
    const parts = ['inputSchema', 'outputSchema'].filter(k => JSON.stringify(e.get(n)[k]) !== JSON.stringify(a.get(n)[k]));
    return parts.length ? [{ name: n, parts }] : [];
  });
  return { added, removed, changed };
}
