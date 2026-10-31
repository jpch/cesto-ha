import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpTransport } from './mcp/client.js';
import type { JobPriority } from './queue.js';
import type { ToolResult } from './mcp/tools.js';

/** Bounded FIFO buffer: keeps the last `size` entries. */
export class Ring<T> {
  private readonly items: T[] = [];
  constructor(readonly size: number) {}
  push(item: T): void { this.items.push(item); if (this.items.length > this.size) this.items.shift(); }
  all(): T[] { return [...this.items]; }
  get length(): number { return this.items.length; }
}

/**
 * Caps log volume: at most `max` lines per window. Dropped lines are counted and reported on the next
 * line that gets through, so the HA log can never be flooded by the add-on.
 */
export class LogLimiter {
  private start = 0;
  private count = 0;
  private dropped = 0;
  constructor(private readonly sink: (line: string) => void, private readonly max = 60, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}
  log(line: string): boolean {
    const t = this.now();
    if (t - this.start >= this.windowMs) { this.start = t; this.count = 0; }
    if (this.count >= this.max) { this.dropped++; return false; }
    this.count++;
    if (this.dropped) { this.sink(`[cesto] log: ${this.dropped} line(s) suppressed (limit ${this.max}/min)`); this.dropped = 0; this.count++; }
    this.sink(line);
    return true;
  }
}

export interface CallRecord { at: string; tool: string; ms: number; ok: boolean; code: string | null; job: string | null; cached: boolean }
export interface JobRecord {
  at: string; label: string; priority: JobPriority; wait_ms: number; run_ms: number; calls: number; mcp_ms: number; cache_hits: number;
  steps: Record<string, { calls: number; ms: number }>; ok: boolean;
}
interface JobContext { label: string; calls: number; mcpMs: number; cacheHits: number; steps: Record<string, { calls: number; ms: number }> }

const round = (n: number) => Math.round(n);
/** Codes that mean the site wants a human (sign-in / CAPTCHA) or is throttling us. */
const SESSION_CODES = new Set(['not_authenticated']);
const THROTTLE_PATTERN = /\b429\b|rate.?limit|too many/i;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/**
 * Lightweight timing instrumentation (1.5.0): in-memory rings of the last calls and jobs, one info summary
 * line per job, per-call lines only at debug level. Nothing is written to files; tool arguments and results
 * (queries, product ids, cart contents) are never recorded, only tool names, durations and error codes.
 */
export class Metrics {
  readonly calls: Ring<CallRecord>;
  readonly jobs: Ring<JobRecord>;
  private readonly context = new AsyncLocalStorage<JobContext>();
  private readonly errorCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  private sessionLost = 0;
  private throttled = 0;
  private signInFailures = 0;
  private readonly startedAt = new Date().toISOString();
  private lastCall: number | null = null;

  /** Milliseconds since the last real MCP call (null before the first one). */
  idleMs(): number | null { return this.lastCall === null ? null : this.now() - this.lastCall; }

  constructor(private readonly log: LogLimiter | null, private readonly debug: boolean, sizes = { calls: 500, jobs: 100 }, private readonly now: () => number = () => performance.now()) {
    this.calls = new Ring(sizes.calls);
    this.jobs = new Ring(sizes.jobs);
  }

  /** Runs a queued job inside a timing context and records/logs one summary for it. */
  async job<T>(info: { label: string; priority: JobPriority; waitMs: number }, run: () => Promise<T>): Promise<T> {
    const ctx: JobContext = { label: info.label, calls: 0, mcpMs: 0, cacheHits: 0, steps: {} };
    const start = this.now();
    let ok = false;
    try {
      const result = await this.context.run(ctx, run);
      ok = true;
      return result;
    } finally {
      const rec: JobRecord = {
        at: new Date().toISOString(), label: info.label, priority: info.priority, wait_ms: round(info.waitMs), run_ms: round(this.now() - start),
        calls: ctx.calls, mcp_ms: round(ctx.mcpMs), cache_hits: ctx.cacheHits,
        steps: Object.fromEntries(Object.entries(ctx.steps).map(([k, v]) => [k, { calls: v.calls, ms: round(v.ms) }])), ok,
      };
      this.jobs.push(rec);
      // Background jobs that made no MCP call (everything cached) are not worth a log line.
      if (rec.calls > 0 || info.priority !== 'background') this.log?.log(jobLine(rec));
    }
  }

  /** Records one MCP call (from TimedTransport). */
  call(tool: string, ms: number, result: ToolResult | null, error?: unknown): void {
    this.lastCall = this.now();
    const raw = error ? 'exception' : result?.status === 'error' ? (result.error?.code ?? 'error') : null;
    // Upstream text never reaches the log or the counters verbatim: short snake_case codes only, bounded key count.
    const code = raw === null ? null : /^[a-z_]{1,40}$/.test(raw) ? raw : 'error';
    const ctx = this.context.getStore();
    if (ctx) {
      ctx.calls++; ctx.mcpMs += ms;
      const s = (ctx.steps[tool] ??= { calls: 0, ms: 0 });
      s.calls++; s.ms += ms;
    }
    if (code && (code in this.errorCounts || Object.keys(this.errorCounts).length < 32)) this.errorCounts[code] = (this.errorCounts[code] ?? 0) + 1;
    if (code && SESSION_CODES.has(code)) this.sessionLost++;
    const message = result?.error?.message ?? (error instanceof Error ? error.message : '');
    if (code && THROTTLE_PATTERN.test(message)) this.throttled++;
    this.calls.push({ at: new Date().toISOString(), tool, ms: round(ms), ok: !code, code, job: ctx?.label ?? null, cached: false });
    if (this.debug) this.log?.log(`[cesto] mcp tool=${tool} ms=${round(ms)} ${code ? `error=${code}` : 'ok'}${ctx ? ` job=${ctx.label}` : ''}`);
  }

  /** A read served from the TTL cache instead of the MCP. */
  cacheHit(tool: string): void {
    const ctx = this.context.getStore();
    if (ctx) ctx.cacheHits++;
    this.calls.push({ at: new Date().toISOString(), tool, ms: 0, ok: true, code: null, job: ctx?.label ?? null, cached: true });
  }

  /** A sign-in attempt that did not succeed (most often the "not a robot" CAPTCHA was not completed). */
  signInFailed(): void { this.signInFailures++; }

  snapshot(queue: { length: number; waiting?: Record<JobPriority, number> }, cache?: Record<string, unknown>) {
    const live = this.calls.all().filter(c => !c.cached);
    const byTool: Record<string, { calls: number; errors: number; p50_ms: number; p95_ms: number; max_ms: number }> = {};
    const grouped = new Map<string, CallRecord[]>();
    for (const c of live) grouped.set(c.tool, [...(grouped.get(c.tool) ?? []), c]);
    for (const [tool, list] of grouped) {
      const ms = list.map(c => c.ms).sort((a, b) => a - b);
      byTool[tool] = { calls: list.length, errors: list.filter(c => !c.ok).length, p50_ms: percentile(ms, 50), p95_ms: percentile(ms, 95), max_ms: ms[ms.length - 1] ?? 0 };
    }
    return {
      since: this.startedAt,
      queue: { length: queue.length, waiting: queue.waiting ?? null },
      tools: byTool,
      cache_hits: this.calls.all().filter(c => c.cached).length,
      errors: { ...this.errorCounts },
      session_lost: this.sessionLost,
      throttled: this.throttled,
      captcha_or_sign_in_failures: this.signInFailures,
      cache: cache ?? null,
      recent_jobs: this.jobs.all().slice(-20).reverse(),
      window: { calls: this.calls.length, calls_max: this.calls.size, jobs: this.jobs.length, jobs_max: this.jobs.size },
    };
  }
}

export function jobLine(r: JobRecord): string {
  const steps = Object.entries(r.steps).map(([k, v]) => `${k}:${v.calls}x${v.ms}`).join(',') || '-';
  return `[cesto] job=${r.label} prio=${r.priority} ${r.ok ? 'ok' : 'failed'} wait_ms=${r.wait_ms} run_ms=${r.run_ms} calls=${r.calls} mcp_ms=${r.mcp_ms} cache_hits=${r.cache_hits} steps=${steps}`;
}

/** Times every MCP tool call. Sits between the test-mode guard and the stdio transport. */
export class TimedTransport implements McpTransport {
  constructor(private readonly inner: McpTransport, private readonly metrics: Metrics, private readonly now: () => number = () => performance.now()) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const start = this.now();
    try {
      const result = await this.inner.callTool(name, args);
      this.metrics.call(name, this.now() - start, result);
      return result;
    } catch (e) {
      this.metrics.call(name, this.now() - start, null, e);
      throw e;
    }
  }
  close() { return this.inner.close(); }
}
