import type { McpTransport } from '../../src/mcp/client.js';
import type { ToolResult } from '../../src/mcp/tools.js';
import { PRODUCTS } from './catalog.js';

/** Stateful in-memory Continente account behind the McpTransport interface. Records every call. */
export class FakeShop implements McpTransport {
  cart = new Map<string, number>();
  calls: { name: string; args: Record<string, unknown> }[] = [];
  unknownFor = new Set<string>();
  notAppliedFor = new Set<string>();
  /** Silently drops a write (confirmed but not in the cart) to test verification. */
  dropFor = new Set<string>();
  expired = false;
  /** get_cart answers with the cart as it was before the writes this many times (the real cart page lags). */
  staleReads = 0;
  private snapshot: Map<string, number> | null = null;
  /** Report quantities as plain numbers (old fixture shape) instead of continentept-mcp 0.12 objects. */
  plainQuantities = false;
  async close(): Promise<void> {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (this.expired) return { status: 'error', error: { code: 'not_authenticated', message: 'sign in', retryable: false } };
    const items = (cart: Map<string, number>) => [...cart].map(([productId, quantity], i) => ({
      productId, cartItemId: `c${i}`, name: `P${productId}`, kind: 'product',
      quantity: this.plainQuantities ? quantity : { status: 'known', quantity: { value: quantity, unit: 'un' } },
    }));
    if (['set_cart_item_quantity', 'clear_cart'].includes(name) && !this.snapshot && this.staleReads > 0) this.snapshot = new Map(this.cart);
    switch (name) {
      case 'get_cart': {
        if (this.snapshot && this.staleReads > 0) { this.staleReads--; return { status: 'success', data: { items: items(this.snapshot) } }; }
        this.snapshot = null;
        return { status: 'success', data: { items: [...items(this.cart), { productId: '1', cartItemId: 'bag', name: 'Saco', kind: 'bag', quantity: { status: 'known', quantity: { value: 1, unit: 'un' } } }] } };
      }
      case 'preview_cart_changes': {
        const wanted = args.items as { productId: string; quantity: number }[];
        const cost = wanted.reduce((s, w) => s + (PRODUCTS.find(p => p.productId === w.productId)?.price?.amount.minorUnits ?? 0) * w.quantity, 0);
        return { status: 'success', data: { lines: wanted.map(w => ({ productId: w.productId, availability: 'available', error: null, current: this.cart.get(w.productId) ?? 0, change: w.quantity - (this.cart.get(w.productId) ?? 0) })), estimatedCost: { currency: 'EUR', minorUnits: cost }, estimated: false, problems: 0 } };
      }
      case 'set_cart_item_quantity': {
        const id = String(args.productId);
        if (this.unknownFor.has(id)) { this.cart.set(id, Number(args.quantity)); return { status: 'error', error: { code: 'timeout', message: 'timeout' }, mutation: { outcome: 'unknown' } } as ToolResult; }
        if (this.notAppliedFor.has(id)) return { status: 'error', error: { code: 'unavailable', message: 'x' }, mutation: { outcome: 'not_applied' } } as ToolResult;
        if (!this.dropFor.has(id)) this.cart.set(id, Number(args.quantity));
        return { status: 'success', data: {}, mutation: { outcome: 'confirmed' } } as ToolResult;
      }
      case 'clear_cart': this.cart.clear(); return { status: 'success', data: {}, mutation: { outcome: 'confirmed' } } as ToolResult;
      default: return { status: 'error', error: { code: 'invalid_input', message: name } };
    }
  }
  mutations() { return this.calls.filter(c => ['set_cart_item_quantity', 'clear_cart', 'add_cart_item', 'remove_cart_item'].includes(c.name)); }
}
