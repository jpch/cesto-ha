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
  async close(): Promise<void> {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (this.expired) return { status: 'error', error: { code: 'not_authenticated', message: 'sign in', retryable: false } };
    const items = () => [...this.cart].map(([productId, quantity], i) => ({ productId, cartItemId: `c${i}`, quantity }));
    switch (name) {
      case 'get_cart': return { status: 'success', data: { items: items() } };
      case 'preview_cart_changes': {
        const wanted = args.items as { productId: string; quantity: number }[];
        const cost = wanted.reduce((s, w) => s + (PRODUCTS.find(p => p.productId === w.productId)?.price?.amount.minorUnits ?? 0) * w.quantity, 0);
        return { status: 'success', data: { lines: wanted.map(w => ({ productId: w.productId, current: this.cart.get(w.productId) ?? 0, change: w.quantity - (this.cart.get(w.productId) ?? 0) })), estimatedCost: { currency: 'EUR', minorUnits: cost }, problems: [] } };
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
