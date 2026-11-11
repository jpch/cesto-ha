import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2.0.0: link to the generic Continente MCP add-on (jpch/continente-mcp-ha), which now owns the Continente
 * account, session, sign-in and browser.
 *
 * - Endpoint: the `continente_mcp_url` option, else `/share/continente-mcp/endpoint.json` written by that add-on.
 * - Token: the `continente_mcp_token` option, else a token Cesto generates and keeps in /data (0600). Only its
 *   SHA-256 hash goes to `/share/continente-mcp/requests/cesto.json`; an HA admin approves it on the
 *   Continente MCP page, where the same fingerprint is shown. The token itself never leaves this add-on.
 * - One-time hand-off: an existing /data/continente (Cesto 1.x) is copied to `/share/continente-mcp/import/`
 *   (READY written last). The other add-on imports it only when it has no session yet, then deletes it.
 * - 2.0.2: the 1.x copy (`credentials.env` with the Continente password, and the browser profile) is deleted
 *   from /data once the hand-off is over and the Continente MCP add-on reports its own account or session, so
 *   no Continente password stays in Cesto's data or in new backups of it.
 */
export interface LinkOptions {
  dataDir: string;
  /** '' disables /share use (tests, local runs). */
  shareDir: string;
  url?: string | null;
  token?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ContinenteHealth {
  version?: string;
  session_valid?: boolean | null;
  session_checked_at?: string | null;
  signing_in?: boolean;
  credentials_configured?: boolean;
  allow_checkout?: boolean;
  queue_length?: number;
  addon_slug?: string | null;
}

export type LegacyPurge = 'purged' | 'none' | 'handoff_pending' | 'no_confirmation';

export type TokenState = 'option' | 'pending_approval' | 'approved' | 'rejected';

export interface LinkStatus {
  /** The Continente MCP add-on answered its last health check. */
  available: boolean;
  url_source: 'option' | 'discovered' | null;
  addon_slug: string | null;
  version: string | null;
  session_valid: boolean | null;
  signing_in: boolean;
  credentials_configured: boolean | null;
  token: TokenState;
  /** Fingerprint of Cesto's own token, to compare with the request on the Continente MCP page. Not a secret. */
  fingerprint: string;
  checked_at: string | null;
}

const TOKEN = /^cmcp_[A-Za-z0-9_-]{43}$/;
const SLUG = /^[a-z0-9]+_[a-z0-9_]+$/;
/** Only a Supervisor add-on host named `<repository hash>-continente-mcp` (or the local dev host). */
const HOST = /^([a-z0-9]{1,16}-continente-mcp|localhost)$/;
export const REQUEST_NAME = 'Cesto';

export const fingerprintOf = (hash: string) => `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase();

const HANDOFF_MARK = 'v2';

export class ContinenteLink {
  private readonly tokenFile: string;
  private readonly secret: string;
  private readonly fromOption: boolean;
  private health: ContinenteHealth | null = null;
  private checkedAt: number | null = null;
  private tokenState: TokenState;

  constructor(private readonly o: LinkOptions) {
    const own = join(o.dataDir, 'continente-mcp');
    this.tokenFile = join(own, 'token');
    const opt = o.token?.trim();
    this.fromOption = !!opt;
    if (opt) this.secret = opt;
    else {
      mkdirSync(own, { recursive: true, mode: 0o700 });
      let t = existsSync(this.tokenFile) ? readFileSync(this.tokenFile, 'utf8').trim() : '';
      if (!TOKEN.test(t)) {
        t = 'cmcp_' + randomBytes(32).toString('base64url');
        writeFileSync(this.tokenFile + '.tmp', t, { mode: 0o600 });
        renameSync(this.tokenFile + '.tmp', this.tokenFile);
      }
      chmodSync(this.tokenFile, 0o600);
      this.secret = t;
    }
    this.tokenState = this.fromOption ? 'option' : existsSync(join(own, 'approved')) ? 'approved' : 'pending_approval';
  }

  get hash(): string { return createHash('sha256').update(this.secret).digest('hex'); }
  get fingerprint(): string { return fingerprintOf(this.hash); }
  /** For the HTTP transport only; never log or return it. */
  get token(): string { return this.secret; }

  private shareFile(...p: string[]): string | null { return this.o.shareDir ? join(this.o.shareDir, ...p) : null; }

  /** The discovered endpoint, re-read every time (the other add-on rewrites it at start). */
  endpoint(): { url: string; source: 'option' | 'discovered' } | null {
    const opt = this.o.url?.trim();
    if (opt) {
      try { const u = new URL(opt); if (u.protocol === 'http:' || u.protocol === 'https:') return { url: u.toString(), source: 'option' }; } catch { /* invalid */ }
      return null;
    }
    const f = this.shareFile('endpoint.json');
    if (!f || !existsSync(f)) return null;
    try {
      const e = JSON.parse(readFileSync(f, 'utf8')) as { hostname?: unknown; port?: unknown; mcp_path?: unknown };
      const port = Number(e.port);
      if (typeof e.hostname !== 'string' || !HOST.test(e.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      const path = typeof e.mcp_path === 'string' && /^\/[a-z/]*$/.test(e.mcp_path) ? e.mcp_path : '/mcp';
      return { url: `http://${e.hostname}:${port}${path}`, source: 'discovered' };
    } catch { return null; }
  }

  /** Writes the token request (hash only) unless the token is configured as an option or already approved. */
  requestToken(): void {
    if (this.fromOption || this.tokenState === 'approved') return;
    const dir = this.shareFile('requests');
    if (!dir || !existsSync(this.o.shareDir)) return;
    const file = join(dir, 'cesto.json');
    try {
      if (existsSync(file)) { const cur = JSON.parse(readFileSync(file, 'utf8')) as { hash?: string }; if (cur.hash === this.hash) return; }
      mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ name: REQUEST_NAME, hash: this.hash, priority: true, requested_at: new Date(this.now()).toISOString() });
      writeFileSync(file + '.tmp', body, { mode: 0o644 });
      renameSync(file + '.tmp', file);
      this.o.log?.(`[continente] token request written (fingerprint ${this.fingerprint}); approve it on the Continente MCP page`);
    } catch (e) { this.o.log?.(`[continente] token request failed: ${(e as Error).message}`); }
  }

  /** Called by the transport: 2xx means the token works, 401 means it is not (or no longer) approved. */
  noteAuth(ok: boolean): void {
    if (this.fromOption) return;
    const marker = join(this.o.dataDir, 'continente-mcp', 'approved');
    if (ok && this.tokenState !== 'approved') { this.tokenState = 'approved'; writeFileSync(marker, ''); }
    if (!ok && this.tokenState === 'approved') { this.tokenState = 'pending_approval'; rmSync(marker, { force: true }); }
    if (!ok) this.requestToken();
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** GET <endpoint>/health (public, no secrets). */
  async refresh(): Promise<ContinenteHealth | null> {
    const ep = this.endpoint();
    this.checkedAt = this.now();
    if (!ep) { this.health = null; return null; }
    try {
      const res = await (this.o.fetch ?? fetch)(new URL('health', ep.url.replace(/[^/]*$/, '')), { signal: AbortSignal.timeout(5000) });
      this.health = res.ok ? (await res.json()) as ContinenteHealth : null;
    } catch { this.health = null; }
    if (this.health) this.requestToken();
    return this.health;
  }

  status(): LinkStatus {
    const h = this.health;
    const slug = typeof h?.addon_slug === 'string' && SLUG.test(h.addon_slug) ? h.addon_slug : null;
    return {
      available: !!h, url_source: this.endpoint()?.source ?? null, addon_slug: slug, version: typeof h?.version === 'string' ? h.version : null,
      session_valid: typeof h?.session_valid === 'boolean' ? h.session_valid : null, signing_in: h?.signing_in === true,
      credentials_configured: typeof h?.credentials_configured === 'boolean' ? h.credentials_configured : null,
      token: this.tokenState, fingerprint: this.fingerprint, checked_at: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
    };
  }

  /**
   * One-time hand-off of a Cesto 1.x session and account. Runs only when the other add-on is installed
   * (endpoint.json exists), there is something to hand off and it was not handed off before.
   */
  handOffSession(): 'handed_off' | 'nothing' | 'done_before' | 'no_addon' {
    const src = join(this.o.dataDir, 'continente');
    const marker = join(this.o.dataDir, 'continente-mcp', 'handed-off');
    // Version 2 of the marker: hand-offs made by 2.0.0 were skipped by Continente MCP 1.0.1, so they run once more.
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === HANDOFF_MARK) return 'done_before';
    const ep = this.shareFile('endpoint.json');
    if (!ep || !existsSync(ep)) return 'no_addon';
    if (!existsSync(src) || readdirSync(src).length === 0) { writeFileSync(marker, HANDOFF_MARK); return 'nothing'; }
    const imp = this.shareFile('import')!, tmp = imp + '.tmp';
    if (existsSync(imp)) return 'no_addon';
    rmSync(tmp, { recursive: true, force: true });
    cpSync(src, tmp, { recursive: true, filter: s => !lstatSync(s).isSymbolicLink() });
    chmodSync(tmp, 0o700);
    renameSync(tmp, imp);
    writeFileSync(join(imp, 'READY'), '', { mode: 0o600 });
    writeFileSync(marker, HANDOFF_MARK);
    this.o.log?.('[continente] Continente session handed off to the Continente MCP add-on');
    return 'handed_off';
  }

  /**
   * Deletes the Cesto 1.x Continente data (`/data/continente`: credentials.env and the browser profile) once
   * it is no longer needed, and only then:
   *  - the hand-off ran (current marker) and the Continente MCP add-on already consumed it (no `import/` left
   *    in /share; it deletes it whether it imported or skipped it), and
   *  - that add-on's last health check says it has its own account (`credentials_configured`) or a valid session.
   * Otherwise nothing is touched and it tries again on the next poll.
   */
  purgeLegacyData(): LegacyPurge {
    const src = join(this.o.dataDir, 'continente');
    if (!existsSync(src)) return 'none';
    const marker = join(this.o.dataDir, 'continente-mcp', 'handed-off');
    const imp = this.shareFile('import');
    const handedOff = existsSync(marker) && readFileSync(marker, 'utf8').trim() === HANDOFF_MARK;
    if (!handedOff || !imp || existsSync(imp) || existsSync(imp + '.tmp')) return 'handoff_pending';
    const h = this.health;
    if (!h || !(h.credentials_configured === true || h.session_valid === true)) return 'no_confirmation';
    rmSync(src, { recursive: true, force: true });
    this.o.log?.('[continente] old Cesto 1.x Continente account and browser profile deleted: the Continente MCP add-on has its own');
    return 'purged';
  }
}
