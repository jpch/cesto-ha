/**
 * Session keep-alive (1.5.0): a light read-only check (get_cart, which never changes the cart) every
 * 20-30 minutes with random jitter, run as a background job. It is skipped when the add-on talked to the
 * site recently anyway, while a sign-in is in progress, and while the session is already known to be
 * expired (the HA notification is already up; checking again would only add traffic).
 */
export interface KeepAliveOptions {
  check: () => Promise<boolean | null>;
  sessionValid: () => boolean | null;
  signingIn: () => boolean;
  /** Milliseconds since the last MCP call of any kind (null: none yet). */
  idleMs: () => number | null;
  minMs?: number;
  maxMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  log?: (line: string) => void;
}

export const KEEPALIVE_MIN_MS = 20 * 60_000;
export const KEEPALIVE_MAX_MS = 30 * 60_000;

export class SessionKeepAlive {
  private stopped = false;
  checks = 0;
  skipped = 0;
  constructor(private readonly o: KeepAliveOptions) {}

  nextDelay(): number {
    const min = this.o.minMs ?? KEEPALIVE_MIN_MS, max = this.o.maxMs ?? KEEPALIVE_MAX_MS;
    return Math.round(min + (this.o.random ?? Math.random)() * (max - min));
  }

  start(): void { this.schedule(); }
  stop(): void { this.stopped = true; }

  private schedule(): void {
    if (this.stopped) return;
    const t = (this.o.setTimer ?? setTimeout)(() => { void this.tick().finally(() => this.schedule()); }, this.nextDelay());
    t.unref?.();
  }

  /** One keep-alive decision; returns whether a check ran. */
  async tick(): Promise<boolean> {
    const idle = this.o.idleMs();
    const recent = idle !== null && idle < (this.o.minMs ?? KEEPALIVE_MIN_MS);
    if (this.stopped || this.o.signingIn() || this.o.sessionValid() === false || recent) { this.skipped++; return false; }
    this.checks++;
    try {
      const valid = await this.o.check();
      if (valid === false) this.o.log?.('[cesto] keep-alive: the Continente session has expired; sign in again from the add-on page.');
    } catch { /* the next tick tries again */ }
    return true;
  }
}
