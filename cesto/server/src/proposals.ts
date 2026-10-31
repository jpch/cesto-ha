import { randomUUID } from 'node:crypto';
import { thumbnailUrl } from './thumbnails.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogReader, Product } from './catalog.js';
import type { HabitsService } from './habits.js';
import type { ListService } from './lists.js';
import { Matcher, type Line } from './matcher.js';
import { productOf } from './mcp/upstream.js';

export interface Proposal { proposal_id: string; store?: string; list_id: number; created_by: string; created_at: string; updated_at: string; revision?: number; lines: Line[] }
export interface PendingProposal {
  proposal_id: string; status: 'matching' | 'failed'; started_at: string;
  progress: { done: number; total: number };
  error?: { status: number; message_key: string };
}
export class ProposalError extends Error { constructor(readonly status: number, readonly key: string) { super(key); } }

/** Matching run over the pending items of the current list; stored so choices and previews can refer to it. */
export class ProposalService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly lists: ListService,
    private readonly catalog: CatalogReader,
    private readonly matcher: Matcher,
    private readonly habits: HabitsService,
  ) {}

  /**
   * One proposal (and so one cart) per supermarket (decision 63): only pending items whose preferred store is
   * `store`, or that have none when `store` is the default connector.
   */
  private itemsFor(itemIds: number[] | undefined, store: string, defaultStore: string) {
    const list = this.lists.current();
    let items = this.lists.items(list.id).filter(i => i.state === 'pending' && (i.store === store || (i.store === null && store === defaultStore)));
    if (itemIds) items = items.filter(i => itemIds.includes(i.id));
    if (!items.length) throw new ProposalError(409, 'error.nothing_to_match');
    return { list, items };
  }

  async create(createdBy: string, itemIds?: number[], store = 'continente', defaultStore = 'continente', opts: { id?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<Proposal> {
    const { list, items } = this.itemsFor(itemIds, store, defaultStore);
    opts.onProgress?.(0, items.length);
    const habits = await this.habits.fresh().catch(() => this.habits.get());
    const lines: Line[] = [];
    for (const item of items) {
      lines.push(await this.matcher.match({ id: item.id, name: item.name, quantity: item.quantity, unit: item.unit, product: item.product }, habits));
      opts.onProgress?.(lines.length, items.length);
    }
    const now = new Date().toISOString();
    const proposal: Proposal = { proposal_id: opts.id ?? randomUUID(), store, list_id: list.id, created_by: createdBy, created_at: now, updated_at: now, lines };
    this.db.prepare('INSERT INTO proposals (id, list_id, created_by, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proposal.proposal_id, list.id, createdBy, JSON.stringify(proposal), now, now);
    return proposal;
  }

  /**
   * Matching runs one Continente search per item through the single MCP queue (plus a daily habits refresh
   * that reads the order history), which can take longer than a phone's HTTP read timeout. Async creation
   * returns at once; the phone polls GET /basket/proposals/:id until it is ready or failed.
   */
  private readonly pending = new Map<string, PendingProposal>();
  createAsync(run: (job: () => Promise<Proposal>) => Promise<Proposal>, createdBy: string, itemIds: number[] | undefined, store: string, defaultStore: string): PendingProposal {
    // A retry while a run is still going returns the same run instead of queueing another one.
    const running = [...this.pending.values()].find(p => p.status === 'matching');
    if (running) return running;
    this.itemsFor(itemIds, store, defaultStore); // 409 now, not after polling
    const id = randomUUID();
    const entry: PendingProposal = { proposal_id: id, status: 'matching', progress: { done: 0, total: 0 }, started_at: new Date().toISOString() };
    this.pending.set(id, entry);
    run(() => this.create(createdBy, itemIds, store, defaultStore, { id, onProgress: (done, total) => { entry.progress = { done, total }; } }))
      .then(() => { this.pending.delete(id); })
      .catch((e: unknown) => {
        entry.status = 'failed';
        entry.error = e instanceof ProposalError ? { status: e.status, message_key: e.key } : { status: 502, message_key: 'error.mcp_unavailable' };
        setTimeout(() => this.pending.delete(id), 10 * 60_000).unref?.();
      });
    return entry;
  }
  pendingRun(id: string): PendingProposal | undefined { return this.pending.get(id); }

  get(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT json FROM proposals WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Proposal) : undefined;
  }

  save(p: Proposal): void {
    p.updated_at = new Date().toISOString();
    p.revision = (p.revision ?? 0) + 1;
    this.db.prepare('UPDATE proposals SET json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(p), p.updated_at, p.proposal_id);
  }

  /** User choice for one line: a product (from the options or any product id), a quantity, or skip. */
  async choose(id: string, itemId: number, input: { product_id?: unknown; quantity?: unknown; skip?: unknown }): Promise<Proposal> {
    const p = this.get(id);
    if (!p) throw new ProposalError(404, 'error.proposal_not_found');
    const line = p.lines.find(l => l.item_id === itemId);
    if (!line) throw new ProposalError(404, 'error.line_not_found');
    if (input.skip !== undefined) {
      if (typeof input.skip !== 'boolean') throw new ProposalError(400, 'error.invalid_request');
      line.skipped = input.skip;
    }
    if (input.product_id !== undefined) {
      if (typeof input.product_id !== 'string' || !/^\d{1,20}$/.test(input.product_id)) throw new ProposalError(400, 'error.invalid_product');
      const known = [line.selected, line.unavailable, ...line.options].find(o => o?.product_id === input.product_id);
      const res = await this.catalog.getProduct(input.product_id);
      const product = productOf(res);
      if (!product) throw new ProposalError(res.error?.code === 'not_found' ? 404 : 502, 'error.product_unavailable');
      line.selected = { product_id: product.productId, name: product.name, package_text: product.packageText ?? null, price: product.price ?? null,
        availability: product.availability ?? 'unknown', image_url: product.imageUrl ?? known?.image_url ?? null,
        thumbnail_url: thumbnailUrl(product.imageUrl ?? known?.image_url), promotions: product.promotions ?? [], reason: known?.reason ?? 'search' };
      line.needs_choice = false;
      line.out_of_stock = product.availability === 'unavailable';
      await this.matcher.finishQuantity(line, product, line.requested, null);
    }
    if (input.quantity !== undefined) {
      if (typeof input.quantity !== 'number' || !(input.quantity > 0) || input.quantity > 999) throw new ProposalError(400, 'error.invalid_quantity');
      line.quantity = input.quantity;
      line.quantity_basis = 'units';
    }
    this.save(p);
    return p;
  }
}
