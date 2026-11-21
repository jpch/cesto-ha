import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2.0.0: link to the generic Continente MCP add-on (jpch/continente-mcp-ha), which now owns the Continente
 * account, session, sign-in and browser.
 *
 * - Endpoint: the `continente_mcp_url` option, else `/share/continente-mcp/endpoint.json` written by that add-on.
 * - Token: the `continente_mcp_token` option, else a token Cesto generates and keeps in /data (0600). Only its
 *   SHA-256 hash goes to `/share/continente-mcp/requests/cesto.json`; an HA admin approves it on the
 *   Continente MCP page, where the same fingerprint is shown. The token itself never leaves this add-on.
 * - A Cesto 1.x copy of the Continente account (`/data/continente`: `credentials.env` with the password, and the
 *   browser profile) is deleted once the Continente MCP add-on reports its own account or session, so no
 *   Continente password stays in Cesto's data or in new backups of it. 2.0.4: it is never handed off any more
 *   (sign in on the Continente MCP add-on page instead), so nothing secret is written to `/share`.
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
  /** 1.0.6: the add-on shows the session-expired notification in Home Assistant itself. */
  ha_notification?: boolean;
  /** 1.0.6: the add-on's session keep-alive (option session_keepalive). */
  session_keepalive?: { enabled?: boolean; state?: string };
}

export type LegacyPurge = 'purged' | 'none' | 'no_confirmation';

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
  /** The add-on shows its own session notification in Home Assistant (1.0.6 or later). */
  ha_notification: boolean;
  /** The add-on's keep-alive is on; null when the add-on does not say (before 1.0.6, or not reachable). */
  session_keepalive: boolean | null;
  token: TokenState;
  /** Fingerprint of Cesto's own token, to compare with the request on the Continente MCP page. Not a secret. */
  fingerprint: string;
  checked_at: string | null;
}

/** How long the add-on's last `ha_notification: true` is trusted while its health does not answer. */
export const ADDON_NOTIFICATION_GRACE_MS = 15 * 60_000;
const TOKEN = /^cmcp_[A-Za-z0-9_-]{43}$/;
const SLUG = /^[a-z0-9]+_[a-z0-9_]+$/;
/** Only a Supervisor add-on host named `<repository hash>-continente-mcp` (or the local dev host). */
const HOST = /^([a-z0-9]{1,16}-continente-mcp|localhost)$/;
export const REQUEST_NAME = 'Cesto';

export const fingerprintOf = (hash: string) => `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase();

export class ContinenteLink {
  private readonly tokenFile: string;
  private readonly secret: string;
  private readonly fromOption: boolean;
  private health: ContinenteHealth | null = null;
  private checkedAt: number | null = null;
  /**
   * The add-on's last reported `ha_notification` and when it was reported. Kept through a short add-on outage
   * (restart, update), so Cesto does not show a second notification meanwhile; an explicit `false` counts at once.
   */
  private addonNotifies: { value: boolean; at: number } | null = null;
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

  /** Whether the add-on shows the session notification: its last report, for up to 15 minutes without a health answer. */
  private haNotification(): boolean {
    const n = this.addonNotifies;
    return !!n && n.value && this.now() - n.at < ADDON_NOTIFICATION_GRACE_MS;
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
    if (this.health) {
      this.addonNotifies = { value: this.health.ha_notification === true, at: this.now() };
      this.requestToken();
    }
    return this.health;
  }

  status(): LinkStatus {
    const h = this.health;
    const slug = typeof h?.addon_slug === 'string' && SLUG.test(h.addon_slug) ? h.addon_slug : null;
    return {
      available: !!h, url_source: this.endpoint()?.source ?? null, addon_slug: slug, version: typeof h?.version === 'string' ? h.version : null,
      session_valid: typeof h?.session_valid === 'boolean' ? h.session_valid : null, signing_in: h?.signing_in === true,
      credentials_configured: typeof h?.credentials_configured === 'boolean' ? h.credentials_configured : null,
      ha_notification: this.haNotification(),
      session_keepalive: typeof h?.session_keepalive?.enabled === 'boolean' ? h.session_keepalive.enabled : null,
      token: this.tokenState, fingerprint: this.fingerprint, checked_at: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
    };
  }

  /**
   * Deletes the Cesto 1.x Continente data (`/data/continente`: credentials.env and the browser profile) once
   * the Continente MCP add-on's last health check says it has its own account (`credentials_configured`) or a
   * valid session. Otherwise nothing is touched and it tries again on the next poll.
   */
  purgeLegacyData(): LegacyPurge {
    const src = join(this.o.dataDir, 'continente');
    if (!existsSync(src)) return 'none';
    const h = this.health;
    if (!h || !(h.credentials_configured === true || h.session_valid === true)) return 'no_confirmation';
    rmSync(src, { recursive: true, force: true });
    this.o.log?.('[continente] old Cesto 1.x Continente account and browser profile deleted: the Continente MCP add-on has its own');
    return 'purged';
  }
}
