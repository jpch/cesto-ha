import type { RunJob } from './queue.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PreferenceStore } from './habits.js';
import type { ListService } from './lists.js';
import type { Line } from './matcher.js';
import type { ToolResult } from './mcp/tools.js';
import { cartItems, estimatedCostOf, isNotAuthenticated, mutationOutcome as outcomeOf, previewProblems, type CartItem, type PreviewProblem } from './mcp/upstream.js';

/** Re-exported for existing callers; the shapes live in mcp/upstream.ts. */
export { cartItems, cartQuantityOf, previewProblems, type PreviewProblem } from './mcp/upstream.js';
import { ProposalError, type Proposal, type ProposalService } from './proposals.js';

/** The account calls the basket needs; ContinenteMcp + CartWriter in production. */
export interface CartApi {
  getCart(): Promise<ToolResult>;
  previewCartChanges(items: { productId: string; quantity: number }[]): Promise<ToolResult>;
  setQuantity(productId: string, quantity: number): Promise<ToolResult>;
  clearCart(): Promise<ToolResult>;
}

export type Mode = 'merge' | 'replace';
export interface Preview {
  preview_id: string; mode: Mode; created_at: string; test_mode: boolean;
  items: { item_id: number; product_id: string; name: string; current: number; add: number; desired: number }[];
  removed: CartItem[]; estimated_cost: unknown; problems: PreviewProblem[];
}
export type JobStatus = 'queued' | 'running' | 'waiting_session' | 'done' | 'simulated' | 'needs_attention' | 'failed';
export interface JobLine {
  item_id: number; product_id: string; name: string; desired: number;
  outcome: 'pending' | 'confirmed' | 'not_applied' | 'unknown' | 'simulated';
  in_cart: boolean | null;
  /** Quantity read back from the cart (null when absent or not readable). */
  found_quantity: number | null;
}
/** Steps shown by the phone's progress screen (decision 53). */
export type JobStep = 'connect' | 'clear' | 'adding' | 'verifying' | 'done';
export interface JobProgress { step: JobStep; done: number; total: number; current: string | null; verify_attempt: number }
export interface Job {
  job_id: string; proposal_id: string; preview_id: string; mode: Mode; test_mode: boolean; status: JobStatus;
  lines: JobLine[]; cart_after: CartItem[] | null; message_key: string | null; created_at: string; updated_at: string;
  progress: JobProgress;
  /** Lines really missing (or short) after the last cart read-back. */
  missing: { item_id: number; product_id: string; name: string; desired: number; found_quantity: number | null }[];
  /** Set when this job only re-sends the missing lines of an earlier one. */
  retry_of: string | null;
}

class SessionExpired extends Error {}
/** Total quantity of a product in the cart; null = present with an unreadable quantity; 0 = absent. */
export function quantityInCart(cart: CartItem[], productId: string): number | null {
  const lines = cart.filter(c => c.productId === String(productId));
  if (!lines.length) return 0;
  if (lines.some(l => l.quantity === null)) return null;
  return lines.reduce((s, l) => s + (l.quantity ?? 0), 0);
}
/** Present with at least the desired quantity (an unreadable quantity on a present line counts as present). */
export const isInCart = (found: number | null, desired: number) => found === null || found >= desired - 1e-6;
/** Delays (ms) before each cart read-back; the cart page can lag behind the writes. */
export const VERIFY_DELAYS_MS = [1000, 2000, 4000, 8000];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const check = (r: ToolResult): ToolResult => { if (isNotAuthenticated(r)) throw new SessionExpired(); return r; };
const active = (p: Proposal) => p.lines.filter((l): l is Line & { selected: NonNullable<Line['selected']> } => !l.skipped && !!l.selected && !l.error && l.quantity > 0);

/**
 * Preview and apply a proposal. Only set_cart_item_quantity (exact totals, idempotent) and clear_cart are
 * used; an `unknown` outcome stops the job and is never replayed. Never checks out or pays.
 */
export class BasketService {
  private readonly jobs = new Map<string, Job>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly lists: ListService,
    private readonly proposals: ProposalService,
    private readonly cart: CartApi,
    private readonly prefs: PreferenceStore,
    private readonly testMode: () => boolean,
    private readonly runJob: RunJob = job => job(),
    private readonly verifyDelays: number[] = VERIFY_DELAYS_MS,
  ) {}

  async preview(proposalId: string, mode: Mode): Promise<Preview> {
    const p = this.proposals.get(proposalId);
    if (!p) throw new ProposalError(404, 'error.proposal_not_found');
    const lines = active(p);
    if (p.lines.some(l => l.needs_choice && !l.skipped)) throw new ProposalError(409, 'error.choices_pending');
    if (!lines.length) throw new ProposalError(409, 'error.nothing_to_apply');
    let current: CartItem[];
    try { current = cartItems(check(await this.cart.getCart())); } catch (e) { throw e instanceof SessionExpired ? new ProposalError(409, 'error.session_expired') : e; }
    const have = (id: string) => mode === 'merge' ? (quantityInCart(current, id) ?? 0) : 0;
    const totals = new Map<string, number>();
    const items = lines.map(l => {
      const id = l.selected.product_id;
      const base = totals.get(id) ?? have(id);
      totals.set(id, base + l.quantity);
      return { item_id: l.item_id, product_id: id, name: l.selected.name, current: have(id), add: l.quantity, desired: base + l.quantity };
    });
    for (const it of items) it.desired = totals.get(it.product_id)!;
    const res = await this.cart.previewCartChanges([...totals].map(([productId, quantity]) => ({ productId, quantity })));
    if (isNotAuthenticated(res)) throw new ProposalError(409, 'error.session_expired');
    const preview: Preview = {
      preview_id: randomUUID(), mode, created_at: new Date().toISOString(), test_mode: this.testMode(), items,
      removed: mode === 'replace' ? current.filter(c => !totals.has(c.productId)) : [],
      estimated_cost: estimatedCostOf(res), problems: previewProblems(res),
    };
    (p as Proposal & { preview?: Preview }).preview = preview;
    this.proposals.save(p);
    // save() bumps the revision; the preview is valid for exactly this version.
    (p as Proposal & { preview_version?: number }).preview_version = p.revision;
    this.db.prepare('UPDATE proposals SET json = ? WHERE id = ?').run(JSON.stringify(p), p.proposal_id);
    return preview;
  }

  apply(proposalId: string, previewId: unknown): Job {
    const p = this.proposals.get(proposalId) as (Proposal & { preview?: Preview; preview_version?: number }) | undefined;
    if (!p) throw new ProposalError(404, 'error.proposal_not_found');
    if (!p.preview || p.preview.preview_id !== previewId || p.preview_version !== p.revision) throw new ProposalError(409, 'error.preview_stale');
    const pv = p.preview;
    const desired = new Map(pv.items.map(i => [i.product_id, i.desired]));
    const now = new Date().toISOString();
    const job: Job = {
      job_id: randomUUID(), proposal_id: p.proposal_id, preview_id: pv.preview_id, mode: pv.mode, test_mode: this.testMode(), status: 'queued',
      lines: pv.items.map(i => ({ item_id: i.item_id, product_id: i.product_id, name: i.name, desired: desired.get(i.product_id)!, outcome: 'pending', in_cart: null, found_quantity: null })),
      cart_after: null, message_key: null, created_at: now, updated_at: now,
      progress: { step: 'connect', done: 0, total: pv.items.length, current: null, verify_attempt: 0 }, missing: [], retry_of: null,
    };
    this.jobs.set(job.job_id, job);
    void this.runJob(() => this.execute(job, p), { priority: 'user', label: 'apply' });
    return job;
  }

  job(id: string): Job | undefined { return this.jobs.get(id); }

  /**
   * "Try adding what is missing": a new job that re-sends set_cart_item_quantity (exact totals, idempotent)
   * only for the lines the read-back found missing, then reads the cart again. Merge mode, never clears.
   */
  retryMissing(jobId: string): Job {
    const old = this.jobs.get(jobId);
    if (!old) throw new ProposalError(404, 'error.job_not_found');
    if (old.status !== 'needs_attention' || !old.missing.length) throw new ProposalError(409, 'error.nothing_to_retry');
    const p = this.proposals.get(old.proposal_id);
    if (!p) throw new ProposalError(404, 'error.proposal_not_found');
    const ids = new Set(old.missing.map(m => m.item_id));
    const now = new Date().toISOString();
    const lines = old.lines.filter(l => ids.has(l.item_id)).map(l => ({ ...l, outcome: 'pending' as const, in_cart: null, found_quantity: null }));
    const job: Job = {
      job_id: randomUUID(), proposal_id: old.proposal_id, preview_id: old.preview_id, mode: 'merge', test_mode: this.testMode(), status: 'queued',
      lines, cart_after: null, message_key: null, created_at: now, updated_at: now,
      progress: { step: 'connect', done: 0, total: lines.length, current: null, verify_attempt: 0 }, missing: [], retry_of: old.job_id,
    };
    this.jobs.set(job.job_id, job);
    void this.runJob(() => this.execute(job, p), { priority: 'user', label: 'apply' });
    return job;
  }

  /** Called when the session becomes valid again: resumes jobs that were waiting for it. */
  resumeWaiting(): void {
    for (const job of this.jobs.values()) if (job.status === 'waiting_session') {
      const p = this.proposals.get(job.proposal_id);
      if (p) { job.status = 'queued'; void this.runJob(() => this.execute(job, p), { priority: 'user', label: 'apply' }); }
    }
  }

  private set(job: Job, status: JobStatus, key: string | null = null) { job.status = status; job.message_key = key; job.updated_at = new Date().toISOString(); }
  private step(job: Job, step: JobStep, current: string | null = null) { job.progress = { ...job.progress, step, current }; job.updated_at = new Date().toISOString(); }

  private async execute(job: Job, p: Proposal): Promise<void> {
    this.set(job, 'running');
    this.step(job, 'connect');
    try {
      const sent = new Map<string, JobLine['outcome']>();
      if (job.mode === 'replace' && job.lines.every(l => l.outcome === 'pending')) {
        this.step(job, 'clear');
        const o = outcomeOf(check(await this.cart.clearCart()));
        if (o !== 'confirmed' && o !== 'simulated') return this.stop(job, o === 'unknown' ? 'needs_attention' : 'failed', o === 'unknown' ? 'basket.unknown_outcome' : 'basket.clear_failed');
      }
      job.progress.done = job.lines.filter(l => l.outcome !== 'pending').length;
      for (const line of job.lines) {
        if (line.outcome !== 'pending') continue;
        this.step(job, 'adding', line.name);
        const done = sent.get(line.product_id);
        if (done) { line.outcome = done; job.progress.done++; continue; }
        const o = outcomeOf(check(await this.cart.setQuantity(line.product_id, line.desired))) as JobLine['outcome'];
        line.outcome = o === 'confirmed' || o === 'simulated' || o === 'not_applied' ? o : 'unknown';
        sent.set(line.product_id, line.outcome);
        job.progress.done++;
        if (line.outcome === 'unknown') return this.stop(job, 'needs_attention', 'basket.unknown_outcome');
      }
      if (job.test_mode) { this.step(job, 'done'); this.record(job, p, 'simulated'); return this.set(job, 'simulated'); }
      await this.verify(job);
      for (const line of job.lines) if (line.in_cart) {
        this.lists.update(line.item_id, { state: 'in_cart' });
        const l = p.lines.find(x => x.item_id === line.item_id);
        if (l?.selected) this.prefs.set(l.item_key, l.selected.product_id, null, p.created_by);
      }
      const ok = job.lines.every(l => l.in_cart);
      this.step(job, 'done');
      this.record(job, p, ok ? 'done' : 'partial');
      this.set(job, ok ? 'done' : 'needs_attention', ok ? null : 'basket.verify_mismatch');
    } catch (e) {
      if (e instanceof SessionExpired) return this.set(job, 'waiting_session', 'basket.waiting_session');
      this.set(job, 'failed', 'basket.failed');
    }
  }

  /**
   * Reads the cart back, waiting and retrying while lines are missing (the cart can lag behind the writes),
   * and compares by product id and quantity. Lines the MCP refused (not_applied) are not waited for.
   */
  private async verify(job: Job): Promise<void> {
    this.step(job, 'verifying');
    const delays = this.verifyDelays.length ? this.verifyDelays : [0];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      job.progress.verify_attempt = attempt + 1;
      if (delays[attempt]! > 0) await sleep(delays[attempt]!);
      const after = cartItems(check(await this.cart.getCart()));
      job.cart_after = after;
      for (const line of job.lines) {
        const found = quantityInCart(after, line.product_id);
        line.found_quantity = found === 0 ? null : found;
        line.in_cart = found !== 0 && isInCart(found, line.desired);
      }
      job.missing = job.lines.filter(l => !l.in_cart)
        .map(l => ({ item_id: l.item_id, product_id: l.product_id, name: l.name, desired: l.desired, found_quantity: l.found_quantity }));
      const waitable = job.lines.some(l => !l.in_cart && l.outcome === 'confirmed');
      if (!job.missing.length || !waitable) return;
    }
  }

  /** After an unknown outcome: read the cart (never replay) and hand over to the user. */
  private async stop(job: Job, status: JobStatus, key: string): Promise<void> {
    try {
      const after = cartItems(await this.cart.getCart());
      job.cart_after = after;
      for (const line of job.lines) {
        const found = quantityInCart(after, line.product_id);
        line.found_quantity = found === 0 ? null : found;
        line.in_cart = found !== 0 && isInCart(found, line.desired);
      }
      job.missing = job.lines.filter(l => !l.in_cart)
        .map(l => ({ item_id: l.item_id, product_id: l.product_id, name: l.name, desired: l.desired, found_quantity: l.found_quantity }));
    } catch { /* keep null */ }
    this.step(job, 'done');
    this.set(job, status, key);
  }

  private record(job: Job, p: Proposal, status: string): void {
    const run = this.db.prepare('INSERT INTO history_runs (list_id, test_mode, status, estimated_total_cents, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.list_id, job.test_mode ? 1 : 0, status, null, new Date().toISOString());
    const ins = this.db.prepare('INSERT INTO history_items (run_id, item_name, product_id, quantity, outcome, product_name) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of job.lines) ins.run(Number(run.lastInsertRowid), p.lines.find(x => x.item_id === l.item_id)?.item_name ?? '', l.product_id, l.desired, l.outcome, l.name || null);
  }
}
