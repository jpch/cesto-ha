import { EventEmitter } from 'node:events';
import type { McpTransport } from './client.js';
import { isMutating, type MutatingTool, type ReadTool, type ToolResult } from './tools.js';

export class MutationBlockedError extends Error {
  constructor(tool: string) { super(`Mutating tool ${tool} blocked`); this.name = 'MutationBlockedError'; }
}

/**
 * Last line of defence: wraps the raw transport and refuses every cart-mutating tool while
 * test mode is on, whatever code path asked for it.
 */
export class TestModeGuard implements McpTransport {
  constructor(private readonly inner: McpTransport, private readonly testMode: () => boolean) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (isMutating(name) && this.testMode()) throw new MutationBlockedError(name);
    return this.inner.callTool(name, args);
  }
  close() { return this.inner.close(); }
}

/** Typed read access plus session tracking. Emits `session` (true/false) on changes. */
export class ContinenteMcp extends EventEmitter {
  sessionValid: boolean | null = null;
  constructor(private readonly transport: McpTransport) { super(); }

  async read(tool: ReadTool, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (isMutating(tool)) throw new MutationBlockedError(tool);
    return this.track(await this.transport.callTool(tool, args));
  }

  /** Used only by CartWriter. */
  async mutate(tool: MutatingTool, args: Record<string, unknown>): Promise<ToolResult> {
    return this.track(await this.transport.callTool(tool, args));
  }

  private track(result: ToolResult): ToolResult {
    const next = result.error?.code === 'not_authenticated' ? false : result.status === 'error' ? this.sessionValid : true;
    if (next !== this.sessionValid) { this.sessionValid = next; this.emit('session', next); }
    return result;
  }

  searchProducts(args: { query: string; limit?: number; cursor?: string; favoritesFirst?: boolean }) { return this.read('search_products', args); }
  getProduct(productId: string) { return this.read('get_product', { productId }); }
  getProductLabels(productIds: string[]) { return this.read('get_product_labels', { productIds }); }
  chooseProducts(decisions: unknown[]) { return this.read('choose_products', { decisions }); }
  listFavorites(refresh = false) { return this.read('list_favorites', { refresh }); }
  getCart() { return this.read('get_cart'); }
  previewCartChanges(items: { productId: string; quantity: number; cartItemId?: string }[]) { return this.read('preview_cart_changes', { items }); }
  listOrders(args: { limit?: number; includeLines?: boolean; cursor?: string } = {}) { return this.read('list_orders', args); }
  getOrder(orderId: string) { return this.read('get_order', { orderId }); }
  listFrequentlyBought(args: { orderLimit?: number; limit?: number } = {}) { return this.read('list_frequently_bought_products', args); }
  getSessionStatus() { return this.read('get_session_status'); }
}

/**
 * The only path to cart mutations. In test mode it never calls the MCP and returns a simulated
 * confirmed outcome instead.
 */
export class CartWriter {
  readonly simulatedLog: { tool: MutatingTool; args: Record<string, unknown> }[] = [];
  constructor(private readonly mcp: ContinenteMcp, private readonly testMode: () => boolean) {}

  private async run(tool: MutatingTool, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.testMode()) {
      this.simulatedLog.push({ tool, args });
      return { status: 'success', simulated: true, data: { outcome: 'simulated', ...args } };
    }
    return this.mcp.mutate(tool, args);
  }

  addItem(productId: string, quantity: number, cartItemId?: string) { return this.run('add_cart_item', { productId, quantity, ...(cartItemId ? { cartItemId } : {}) }); }
  setQuantity(productId: string, quantity: number, cartItemId?: string) { return this.run('set_cart_item_quantity', { productId, quantity, ...(cartItemId ? { cartItemId } : {}) }); }
  removeItem(productId: string, cartItemId?: string) { return this.run('remove_cart_item', { productId, ...(cartItemId ? { cartItemId } : {}) }); }
  clearCart() { return this.run('clear_cart', { confirm: true }); }
}
