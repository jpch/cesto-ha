/**
 * Cesto against the continentept-mcp version the Continente MCP add-on really pins.
 *
 * Reads `ARG CONTINENTEPT_MCP_VERSION` from that add-on's `continente_mcp/Dockerfile` and its reviewed
 * snapshot, from a checkout of jpch/continente-mcp-ha given in CONTINENTE_MCP_HA_DIR (CI checks it out;
 * locally the test is skipped without it). Fails when the add-on pins a version Cesto has no reviewed
 * snapshot for, when the two snapshots differ, or when Cesto's calls or fixtures do not fit that version.
 * No Continente login, no network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED_TOOLS, isForbidden } from '../../src/mcp/tools.js';
import { diff, normalise } from './snapshot.mjs';
import { SNAPSHOTS, cestoCalls, fixturesFor, raw, snapshotFor, validator, type Snapshot } from './support.js';

const root = process.env.CONTINENTE_MCP_HA_DIR ?? '';
const present = !!root && existsSync(join(root, 'continente_mcp', 'Dockerfile'));
if (process.env.CI && root && !present) throw new Error(`CONTINENTE_MCP_HA_DIR=${root} has no continente_mcp/Dockerfile`);

/** `ARG CONTINENTEPT_MCP_VERSION=x.y.z` in the add-on's Dockerfile (the same line its CI reads). */
export function pinnedVersion(dockerfile: string): string | null {
  return /^ARG CONTINENTEPT_MCP_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1] ?? null;
}

describe('pinnedVersion', () => {
  it('reads the ARG line and nothing else', () => {
    expect(pinnedVersion('FROM x\nARG CONTINENTEPT_MCP_VERSION=0.13.0\nRUN npm i -g "continentept-mcp@${CONTINENTEPT_MCP_VERSION}"\n')).toBe('0.13.0');
    expect(pinnedVersion('ARG CONTINENTEPT_MCP_VERSION=latest\n')).toBeNull();
    expect(pinnedVersion('# ARG CONTINENTEPT_MCP_VERSION=0.13.0\n')).toBeNull();
  });
});

describe.skipIf(!present)('Cesto against the continentept-mcp the Continente MCP add-on pins', () => {
  const version = present ? pinnedVersion(readFileSync(join(root, 'continente_mcp', 'Dockerfile'), 'utf8')) : null;
  const theirs = present ? JSON.parse(readFileSync(join(root, 'continente_mcp', 'server', 'contract', 'upstream-tools.json'), 'utf8')) as Snapshot : null;
  const ours = version ? snapshotFor(version) : undefined;

  it('the pinned version is one Cesto has a reviewed snapshot for', () => {
    expect(version, 'ARG CONTINENTEPT_MCP_VERSION in continente_mcp/Dockerfile').toMatch(/^\d+\.\d+\.\d+$/);
    expect(SNAPSHOTS.map(s => s.version), `Cesto supports; the add-on pins ${version}`).toContain(version);
  });
  it("the add-on's reviewed snapshot is the same contract as Cesto's", () => {
    expect(theirs!.version).toBe(version);
    expect(diff(ours!.tools, normalise(theirs!.tools))).toEqual({ added: [], removed: [], changed: [] });
  });
  it('every allowlisted tool exists there; every other tool there is forbidden', () => {
    const names = theirs!.tools.map(t => t.name);
    for (const name of ALLOWED_TOOLS) expect(names).toContain(name);
    for (const name of names.filter(n => !ALLOWED_TOOLS.includes(n))) expect(isForbidden(name), name).toBe(true);
  });
  it("Cesto's calls fit the pinned input schemas", async () => {
    for (const c of await cestoCalls()) {
      const validate = validator(theirs!, c.name, 'inputSchema');
      expect(validate(c.args), `${c.name}: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    }
  });
  it('the fixtures the adapters are tested on fit the pinned output schemas', () => {
    for (const file of fixturesFor(version!)) {
      const validate = validator(theirs!, file.split('.')[0], 'outputSchema');
      expect(validate(JSON.parse(raw(file))), `${file}: ${JSON.stringify(validate.errors?.slice(0, 2))}`).toBe(true);
    }
  });
});
