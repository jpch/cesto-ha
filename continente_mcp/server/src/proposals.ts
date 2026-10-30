import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogReader, Product } from './catalog.js';
import type { HabitsService } from './habits.js';
import type { ListService } from './lists.js';
import { Matcher, type Line } from './matcher.js';

export interface Proposal { proposal_id: string; list_id: number; created_by: string; created_at: string; updated_at: string; lines: Line[] }
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

  async create(createdBy: string, itemIds?: number[]): Promise<Proposal> {
    const list = this.lists.current();
    let items = this.lists.items(list.id).filter(i => i.state === 'pending');
    if (itemIds) items = items.filter(i => itemIds.includes(i.id));
    if (!items.length) throw new ProposalError(409, 'error.nothing_to_match');
    const habits = await this.habits.fresh().catch(() => this.habits.get());
    const lines: Line[] = [];
    for (const item of items) lines.push(await this.matcher.match({ id: item.id, name: item.name, quantity: item.quantity, unit: item.unit }, habits));
    const now = new Date().toISOString();
    const proposal: Proposal = { proposal_id: randomUUID(), list_id: list.id, created_by: createdBy, created_at: now, updated_at: now, lines };
    this.db.prepare('INSERT INTO proposals (id, list_id, created_by, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proposal.proposal_id, list.id, createdBy, JSON.stringify(proposal), now, now);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT json FROM proposals WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Proposal) : undefined;
  }

  save(p: Proposal): void {
    p.updated_at = new Date().toISOString();
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
      if (res.status === 'error' || !res.data) throw new ProposalError(res.error?.code === 'not_found' ? 404 : 502, 'error.product_unavailable');
      const product = res.data as unknown as Product;
      line.selected = { product_id: product.productId, name: product.name, package_text: product.packageText ?? null, price: product.price ?? null,
        availability: product.availability ?? 'unknown', image_url: product.imageUrl ?? known?.image_url ?? null, promotions: product.promotions ?? [], reason: known?.reason ?? 'search' };
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
