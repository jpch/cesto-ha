/** Priority of a queued MCP job: user actions first, then interactive reads, then background work. */
export type JobPriority = 'user' | 'normal' | 'background';
export interface JobOptions { priority?: JobPriority; label?: string }
export type RunJob = <T>(job: () => Promise<T>, options?: JobOptions) => Promise<T>;

/** Observes each job: wait time in the queue and the job itself (timing instrumentation). */
export type JobObserver = <T>(info: { label: string; priority: JobPriority; waitMs: number }, job: () => Promise<T>) => Promise<T>;

const ORDER: JobPriority[] = ['user', 'normal', 'background'];

/**
 * Single-worker job queue: one MCP job at a time (decision 17). Within a priority jobs run FIFO;
 * a waiting `user` job always runs before waiting `normal` and `background` jobs. A running job is never interrupted.
 */
export class JobQueue {
  private readonly lanes: Record<JobPriority, (() => Promise<void>)[]> = { user: [], normal: [], background: [] };
  private busy = false;
  private pending = 0;

  constructor(private readonly observe?: JobObserver, private readonly now: () => number = () => performance.now()) {}

  get length(): number { return this.pending; }

  /** Waiting (not running) jobs per priority. */
  waiting(): Record<JobPriority, number> { return { user: this.lanes.user.length, normal: this.lanes.normal.length, background: this.lanes.background.length }; }

  run<T>(job: () => Promise<T>, options: JobOptions = {}): Promise<T> {
    const priority = options.priority ?? 'normal';
    const label = options.label ?? 'job';
    const queuedAt = this.now();
    this.pending++;
    return new Promise<T>((resolve, reject) => {
      this.lanes[priority].push(async () => {
        const waitMs = this.now() - queuedAt;
        try {
          resolve(await (this.observe ? this.observe({ label, priority, waitMs }, job) : job()));
        } catch (e) { reject(e); }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const lane = ORDER.find(p => this.lanes[p].length);
        if (!lane) break;
        const next = this.lanes[lane].shift()!;
        try { await next(); } finally { this.pending--; }
      }
    } finally { this.busy = false; }
  }
}
