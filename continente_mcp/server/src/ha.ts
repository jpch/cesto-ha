import { readFileSync } from 'node:fs';

export interface HaOptions {
  /** Supervisor base URL, normally http://supervisor. */
  supervisorUrl: string;
  token: string;
  language: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface HaSnapshot {
  version: string;
  testMode: boolean;
  sessionValid: boolean | null;
  queueLength: number;
  pendingItems: number;
  totalItems: number;
  lastSync: string | null;
}

const NOTIFICATION_ID = 'continente_mcp_session_expired';

/** Strings come from the same i18n files as the web page (pt-PT default). */
export function haStrings(language: string): Record<string, string> {
  const file = language.toLowerCase().startsWith('en') ? 'en' : 'pt-PT';
  return JSON.parse(readFileSync(new URL(`../web/i18n/${file}.json`, import.meta.url), 'utf8')) as Record<string, string>;
}

/**
 * Home Assistant integration through the Supervisor proxy to the Core API: four entities and a
 * persistent notification while the Continente session is expired. Failures are logged, never thrown.
 */
export class HaIntegration {
  private readonly fetch: typeof fetch;
  private readonly t: Record<string, string>;
  private ingressUrl: string | null = null;
  private notified = false;
  private lastSession: boolean | null | undefined;

  constructor(private readonly o: HaOptions) {
    this.fetch = o.fetchImpl ?? fetch;
    this.t = haStrings(o.language);
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    try {
      const res = await this.fetch(`${this.o.supervisorUrl}${path}`, {
        method, headers: { authorization: `Bearer ${this.o.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) { this.o.log?.(`[ha] ${method} ${path} -> ${res.status}`); return undefined; }
      return await res.json().catch(() => undefined);
    } catch (error) {
      this.o.log?.(`[ha] ${method} ${path} failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Link to the add-on page in the HA frontend, e.g. /hassio/ingress/abcd1234_continente_mcp. */
  async pageUrl(): Promise<string> {
    if (!this.ingressUrl) {
      const info = await this.call('GET', '/addons/self/info') as { data?: { slug?: string } } | undefined;
      const slug = info?.data?.slug;
      if (slug) this.ingressUrl = `/hassio/ingress/${slug}`;
    }
    return this.ingressUrl ?? '/hassio/ingress/continente_mcp';
  }

  private state(entity: string, state: string, attributes: Record<string, unknown>) {
    return this.call('POST', `/core/api/states/${entity}`, { state, attributes });
  }

  async publish(s: HaSnapshot): Promise<void> {
    const t = this.t;
    await Promise.all([
      this.state('sensor.continente_server_status', s.testMode ? 'test_mode' : 'online', {
        friendly_name: t['ha.server_status'], icon: 'mdi:cart', version: s.version, test_mode: s.testMode, queue_length: s.queueLength,
      }),
      this.state('binary_sensor.continente_session_valid', s.sessionValid === null ? 'unknown' : s.sessionValid ? 'on' : 'off', {
        friendly_name: t['ha.session_valid'], device_class: 'connectivity',
      }),
      this.state('sensor.continente_list_items', String(s.pendingItems), {
        friendly_name: t['ha.list_items'], icon: 'mdi:format-list-checks', unit_of_measurement: 'items', state_class: 'measurement', total_items: s.totalItems,
      }),
      this.state('sensor.continente_last_sync', s.lastSync ?? 'unknown', {
        friendly_name: t['ha.last_sync'], device_class: 'timestamp',
      }),
    ]);
    await this.session(s.sessionValid);
  }

  /** Notify once when the session becomes invalid; dismiss when it is valid again. */
  async session(valid: boolean | null): Promise<void> {
    if (valid === this.lastSession) return;
    this.lastSession = valid;
    if (valid === false && !this.notified) {
      const url = await this.pageUrl();
      await this.call('POST', '/core/api/services/persistent_notification/create', {
        notification_id: NOTIFICATION_ID,
        title: this.t['ha.session_expired.title'],
        message: (this.t['ha.session_expired.message'] ?? '').replace('{url}', url),
      });
      this.notified = true;
    } else if (valid === true && this.notified) {
      await this.call('POST', '/core/api/services/persistent_notification/dismiss', { notification_id: NOTIFICATION_ID });
      this.notified = false;
    }
  }
}

/** Counts for the list sensors from the current list. */
export function listStats(db: import('node:sqlite').DatabaseSync): { pendingItems: number; totalItems: number; lastSync: string | null } {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN i.state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
      COUNT(i.id) AS total,
      MAX(COALESCE(i.updated_at, l.updated_at), l.updated_at) AS last
    FROM lists l LEFT JOIN items i ON i.list_id = l.id AND i.deleted = 0
    WHERE l.status = 'active'`).get() as { pending: number; total: number; last: string | null } | undefined;
  const changed = (db.prepare(`SELECT MAX(updated_at) AS m FROM items`).get() as { m: string | null }).m;
  const last = [row?.last ?? null, changed].filter(Boolean).sort().pop() ?? null;
  return { pendingItems: Number(row?.pending ?? 0), totalItems: Number(row?.total ?? 0), lastSync: last };
}
