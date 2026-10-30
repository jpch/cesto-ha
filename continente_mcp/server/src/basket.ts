import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PreferenceStore } from './habits.js';
import type { ListService } from './lists.js';
import type { Line } from './matcher.js';
import type { ToolResult } from './mcp/tools.js';
import { ProposalError, type Proposal, type ProposalService } from './proposals.js';

/** The account calls the basket needs; ContinenteMcp + CartWriter in production. */
export interface CartApi {
  getCart(): Promise<ToolResult>;
  previewCartChanges(items: { productId: string; quantity: number }[]): Promise<ToolResult>;
  setQuantity(productId: string, quantity: number): Promise<ToolResult>;
  clearCart(): Promise<ToolResult>;
}

export type Mode = 'merge' | 'replace';
interface CartItem { productId: string; quantity: number }
export interface Preview {
  preview_id: string; mode: Mode; created_at: string; test_mode: boolean;
  items: { item_id: number; product_id: string; name: string; current: number; add: number; desired: number }[];
  removed: CartItem[]; estimated_cost: unknown; problems: unknown[];
}
export type JobStatus = 'queued' | 'running' | 'waiting_session' | 'done' | 'simulated' | 'needs_attention' | 'failed';
export interface JobLine { item_id: number; product_id: string; desired: number; outcome: 'pending' | 'confirmed' | 'not_applied' | 'unknown' | 'simulated'; in_cart: boolean | null }
export interface Job {
  job_id: string; proposal_id: string; preview_id: string; mode: Mode; test_mode: boolean; status: JobStatus;
  lines: JobLine[]; cart_after: CartItem[] | null; message_key: string | null; created_at: string; updated_at: string;
}

class SessionExpired extends Error {}
const cartItems = (r: ToolResult): CartItem[] =>
  ((r.data?.items ?? []) as { productId: string; quantity: number }[]).map(i => ({ productId: String(i.productId), quantity: Number(i.quantity) }));
const outcomeOf = (r: ToolResult): string => {
  if (r.simulated) return 'simulated';
  const o = (r as { mutation?: { outcome?: string } }).mutation?.outcome ?? (r.data?.outcome as string | undefined);
  return o ?? (r.status === 'error' ? 'not_applied' : 'unknown');
};
const check = (r: ToolResult): ToolResult => { if (r.error?.code === 'not_authenticated') throw new SessionExpired(); return r; };
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
    private readonly runJob: <T>(job: () => Promise<T>) => Promise<T> = job => job(),
  ) {}

  async preview(proposalId: string, mode: Mode): Promise<Preview> {
    const p = this.proposals.get(proposalId);
    if (!p) throw new ProposalError(404, 'error.proposal_not_found');
    const lines = active(p);
    if (p.lines.some(l => l.needs_choice && !l.skipped)) throw new ProposalError(409, 'error.choices_pending');
    if (!lines.length) throw new ProposalError(409, 'error.nothing_to_apply');
    let current: CartItem[];
    try { current = cartItems(check(await this.cart.getCart())); } catch (e) { throw e instanceof SessionExpired ? new ProposalError(409, 'error.session_expired') : e; }
    const have = (id: string) => mode === 'merge' ? current.filter(c => c.productId === id).reduce((s, c) => s + c.quantity, 0) : 0;
    const totals = new Map<string, number>();
    const items = lines.map(l => {
      const id = l.selected.product_id;
      const base = totals.get(id) ?? have(id);
      totals.set(id, base + l.quantity);
      return { item_id: l.item_id, product_id: id, name: l.selected.name, current: have(id), add: l.quantity, desired: base + l.quantity };
    });
    for (const it of items) it.desired = totals.get(it.product_id)!;
    const res = await this.cart.previewCartChanges([...totals].map(([productId, quantity]) => ({ productId, quantity })));
    if (res.error?.code === 'not_authenticated') throw new ProposalError(409, 'error.session_expired');
    const preview: Preview = {
      preview_id: randomUUID(), mode, created_at: new Date().toISOString(), test_mode: this.testMode(), items,
      removed: mode === 'replace' ? current.filter(c => !totals.has(c.productId)) : [],
      estimated_cost: res.data?.estimatedCost ?? null, problems: (res.data?.problems as unknown[]) ?? [],
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
      lines: pv.items.map(i => ({ item_id: i.item_id, product_id: i.product_id, desired: desired.get(i.product_id)!, outcome: 'pending', in_cart: null })),
      cart_after: null, message_key: null, created_at: now, updated_at: now,
    };
    this.jobs.set(job.job_id, job);
    void this.runJob(() => this.execute(job, p));
    return job;
  }

  job(id: string): Job | undefined { return this.jobs.get(id); }

  /** Called when the session becomes valid again: resumes jobs that were waiting for it. */
  resumeWaiting(): void {
    for (const job of this.jobs.values()) if (job.status === 'waiting_session') {
      const p = this.proposals.get(job.proposal_id);
      if (p) { job.status = 'queued'; void this.runJob(() => this.execute(job, p)); }
    }
  }

  private set(job: Job, status: JobStatus, key: string | null = null) { job.status = status; job.message_key = key; job.updated_at = new Date().toISOString(); }

  private async execute(job: Job, p: Proposal): Promise<void> {
    this.set(job, 'running');
    try {
      const sent = new Map<string, JobLine['outcome']>();
      if (job.mode === 'replace' && job.lines.every(l => l.outcome === 'pending')) {
        const o = outcomeOf(check(await this.cart.clearCart()));
        if (o !== 'confirmed' && o !== 'simulated') return this.stop(job, o === 'unknown' ? 'needs_attention' : 'failed', o === 'unknown' ? 'basket.unknown_outcome' : 'basket.clear_failed');
      }
      for (const line of job.lines) {
        if (line.outcome !== 'pending') continue;
        const done = sent.get(line.product_id);
        if (done) { line.outcome = done; continue; }
        const o = outcomeOf(check(await this.cart.setQuantity(line.product_id, line.desired))) as JobLine['outcome'];
        line.outcome = o === 'confirmed' || o === 'simulated' || o === 'not_applied' ? o : 'unknown';
        sent.set(line.product_id, line.outcome);
        if (line.outcome === 'unknown') return this.stop(job, 'needs_attention', 'basket.unknown_outcome');
      }
      if (job.test_mode) { this.record(job, p, 'simulated'); return this.set(job, 'simulated', 'basket.simulated'); }
      const after = cartItems(check(await this.cart.getCart()));
      job.cart_after = after;
      for (const line of job.lines) {
        const qty = after.filter(c => c.productId === line.product_id).reduce((s, c) => s + c.quantity, 0);
        line.in_cart = qty >= line.desired - 1e-9;
      }
      for (const line of job.lines) if (line.in_cart) {
        this.lists.update(line.item_id, { state: 'in_cart' });
        const l = p.lines.find(x => x.item_id === line.item_id);
        if (l?.selected) this.prefs.set(l.item_key, l.selected.product_id, null, p.created_by);
      }
      const ok = job.lines.every(l => l.in_cart);
      this.record(job, p, ok ? 'done' : 'partial');
      this.set(job, ok ? 'done' : 'needs_attention', ok ? null : 'basket.verify_mismatch');
    } catch (e) {
      if (e instanceof SessionExpired) return this.set(job, 'waiting_session', 'basket.waiting_session');
      this.set(job, 'failed', 'basket.failed');
    }
  }

  /** After an unknown outcome: read the cart (never replay) and hand over to the user. */
  private async stop(job: Job, status: JobStatus, key: string): Promise<void> {
    try { job.cart_after = cartItems(await this.cart.getCart()); } catch { /* keep null */ }
    this.set(job, status, key);
  }

  private record(job: Job, p: Proposal, status: string): void {
    const run = this.db.prepare('INSERT INTO history_runs (list_id, test_mode, status, estimated_total_cents, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.list_id, job.test_mode ? 1 : 0, status, null, new Date().toISOString());
    const ins = this.db.prepare('INSERT INTO history_items (run_id, item_name, product_id, quantity, outcome) VALUES (?, ?, ?, ?, ?)');
    for (const l of job.lines) ins.run(Number(run.lastInsertRowid), p.lines.find(x => x.item_id === l.item_id)?.item_name ?? '', l.product_id, l.desired, l.outcome);
  }
}
