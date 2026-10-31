#!/usr/bin/env node
/**
 * Prepares a continentept-mcp update in the working tree (used by .github/workflows/upstream-bump.yaml):
 * sets the Dockerfile ARG, bumps the add-on patch version everywhere it is recorded and adds a
 * CHANGELOG section. It never touches the tool allowlist or the contract snapshot: those change only
 * after a human review.
 *
 *   node scripts/bump-upstream.mjs <new continentept-mcp version> [--date YYYY-MM-DD] [--contract-changed]
 * Prints the new add-on version.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const file = p => join(root, p);
const edit = (p, fn) => { const before = readFileSync(file(p), 'utf8'); const after = fn(before); if (after === before) throw new Error(`${p}: nothing changed`); writeFileSync(file(p), after); };

export function nextPatch(v) { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; }

function main() {
  const [upstream] = process.argv.slice(2);
  const d = process.argv.indexOf('--date');
  const date = d >= 0 ? process.argv[d + 1] : new Date().toISOString().slice(0, 10);
  if (!upstream || !SEMVER.test(upstream)) throw new Error('usage: bump-upstream.mjs <x.y.z>');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad --date');

  const docker = readFileSync(file('cesto/Dockerfile'), 'utf8');
  const previous = docker.match(/^ARG CONTINENTEPT_MCP_VERSION=(\S+)$/m)?.[1];
  if (!previous) throw new Error('Dockerfile ARG not found');
  if (previous === upstream) throw new Error(`already on ${upstream}`);
  const current = readFileSync(file('cesto/config.yaml'), 'utf8').match(/^version:\s*"?([\d.]+)"?\s*$/m)?.[1];
  if (!current || !SEMVER.test(current)) throw new Error('config.yaml version not found');
  const next = nextPatch(current);
  const note = process.argv.includes('--contract-changed')
    ? 'automated update; the tool contract changed and was reviewed before merging'
    : 'automated update; the tool contract check found no added, removed or changed tools';

  edit('cesto/Dockerfile', s => s.replace(/^ARG CONTINENTEPT_MCP_VERSION=\S+$/m, `ARG CONTINENTEPT_MCP_VERSION=${upstream}`));
  edit('cesto/config.yaml', s => s.replace(/^version:\s*"?[\d.]+"?\s*$/m, `version: "${next}"`));
  edit('cesto/server/package.json', s => s.replace(/^( {2}"version": )"[\d.]+"/m, `$1"${next}"`));
  edit('cesto/server/package-lock.json', s => {
    const j = JSON.parse(s); j.version = next; j.packages[''].version = next; return JSON.stringify(j, null, 2) + '\n';
  });
  edit('cesto/server/openapi.yaml', s => s.replace(/^( {2}version: )[\d.]+$/m, `$1${next}`));
  edit('CHANGELOG.md', s => s.replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${next}] - ${date}\n### Changed\n- Bundled \`continentept-mcp\` updated from ${previous} to ${upstream} (${note}).\n`));
  console.log(next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
}
