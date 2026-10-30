/** Single-worker FIFO job queue: one MCP job at a time (decision 17). */
export class JobQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get length(): number { return this.pending; }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(job, job);
    this.tail = result.then(() => undefined, () => undefined).finally(() => { this.pending--; });
    return result;
  }
}
