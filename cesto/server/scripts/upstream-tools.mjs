#!/usr/bin/env node
/**
 * Contract check against the installed continentept-mcp package, without signing in.
 *
 * Starts the package over stdio, reads tools/list and compares every tool's name, input schema and
 * output schema with the committed snapshot (test/contract/upstream-tools.json). Descriptions and
 * titles (tool and schema text) are ignored: only shapes matter.
 *
 *   node scripts/upstream-tools.mjs --check            exit 1 on any difference, Markdown report on stdout
 *   node scripts/upstream-tools.mjs --write            refresh the snapshot (after a human review only)
 *   --report <file>   also write a JSON summary {added, removed, changed, version}
 *
 * The command defaults to `continentept-mcp` on PATH (MCP_COMMAND overrides it). The data directory
 * is a fresh temporary directory, so no saved session, cookie or credential is ever read.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(here, '..', 'test', 'contract', 'upstream-tools.json');

/** Deterministic JSON: object keys sorted, so key order never shows up as a change. */
export const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;

/** Drops human text (description/title/examples strings), keeping only the shape. */
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

/** Same pattern as FORBIDDEN_TOOL in src/mcp/tools.ts (a contract test keeps them equal). */
export const FORBIDDEN = /checkout|pay|order_(create|place|submit|confirm)|(place|submit|confirm|create|finali[sz]e)_?order|purchase|buy|slot|deliver|voucher|coupon|billing|card/i;

/** Tool names come from the package: anything outside a plain identifier is shown escaped. */
const safe = n => /^[A-Za-z0-9_.-]{1,80}$/.test(n) ? `\`${n}\`` : `\`${JSON.stringify(String(n).slice(0, 80)).replace(/`/g, "'")}\` (unusual name)`;

export function report(d, version) {
  const v = /^[\w.+-]{1,40}$/.test(String(version ?? '')) ? version : '';
  const lines = [`### continentept-mcp ${v} tool contract`.replace('  ', ' '), ''];
  if (!d.added.length && !d.removed.length && !d.changed.length) return [...lines, 'No tool was added or removed and every input and output schema matches the snapshot.'].join('\n');
  if (d.added.length) lines.push('**New upstream tools (blocked by the allowlist until reviewed):**', ...d.added.map(n => `- ${safe(n)}${FORBIDDEN.test(n) ? ' **(checkout/payment-like name: permanently forbidden by the tool policy)**' : ''}`), '');
  if (d.removed.length) lines.push('**Removed upstream tools:**', ...d.removed.map(n => `- ${safe(n)}`), '');
  if (d.changed.length) lines.push('**Changed schemas:**', ...d.changed.map(c => `- ${safe(c.name)}: ${c.parts.join(', ')}`), '');
  lines.push('Auto-merge is blocked: review the changes, update the adapters, fixtures and allowlist, then refresh the snapshot with `npm run contract:write`.');
  return lines.join('\n');
}

async function listTools() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-contract-'));
  const env = { PATH: process.env.PATH ?? '', HOME: dataDir, CONTINENTE_DATA_DIR: dataDir, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' };
  const transport = new StdioClientTransport({ command: process.env.MCP_COMMAND ?? 'continentept-mcp', args: [], env, stderr: 'ignore' });
  const client = new Client({ name: 'cesto-ha-contract', version: '1' });
  try {
    await client.connect(transport);
    const version = client.getServerVersion()?.version ?? null;
    const tools = [];
    let cursor;
    do { const r = await client.listTools(cursor ? { cursor } : {}); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
    return { version, tools: normalise(tools) };
  } finally { await client.close().catch(() => {}); rmSync(dataDir, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  const { version, tools } = await listTools();
  if (args.includes('--write')) {
    writeFileSync(SNAPSHOT, JSON.stringify({ package: 'continentept-mcp', version, tools }, null, 2) + '\n');
    console.log(`Snapshot written: ${tools.length} tools from continentept-mcp ${version}`);
    return;
  }
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const d = diff(snapshot.tools, tools);
  const r = args.indexOf('--report');
  if (r >= 0 && args[r + 1]) writeFileSync(args[r + 1], JSON.stringify({ version, ...d }, null, 2) + '\n');
  console.log(report(d, version));
  if (d.added.length || d.removed.length || d.changed.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 2; });
