import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { StdioMcpTransport, type McpTransport } from '../src/mcp/client.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from '../src/mcp/continente.js';
import { ALLOWED_TOOLS, ForbiddenToolError, isForbidden, MUTATING_TOOLS, READ_TOOLS } from '../src/mcp/tools.js';
import type { ToolResult } from '../src/mcp/tools.js';

const FORBIDDEN = ['checkout', 'start_checkout', 'go_to_checkout', 'pay', 'submit_payment', 'add_payment_method', 'place_order', 'submit_order',
  'confirm_order', 'create_order', 'order_place', 'finalize_order', 'purchase', 'buy_now', 'book_delivery_slot', 'choose_delivery', 'apply_voucher',
  'add_coupon', 'set_billing_address', 'add_card', 'unknown_new_tool', ''];

class Recorder implements McpTransport {
  calls: string[] = [];
  async callTool(name: string): Promise<ToolResult> { this.calls.push(name); return { status: 'success', data: { outcome: 'confirmed' } }; }
  async close() {}
}

describe('hard tool policy (no option can disable it)', () => {
  it('allows exactly the read and cart tools', () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual([...READ_TOOLS, ...MUTATING_TOOLS].sort());
    for (const t of ALLOWED_TOOLS) expect(isForbidden(t)).toBe(false);
  });

  it.each(FORBIDDEN)('refuses %s at every layer, with test mode off', async tool => {
    const inner = new Recorder();
    const guard = new TestModeGuard(inner, () => false);
    await expect(guard.callTool(tool, {})).rejects.toBeInstanceOf(ForbiddenToolError);
    const mcp = new ContinenteMcp(guard);
    await expect(mcp.read(tool as never, {})).rejects.toBeInstanceOf(ForbiddenToolError);
    await expect(mcp.mutate(tool as never, {})).rejects.toBeInstanceOf(ForbiddenToolError);
    expect(inner.calls).toEqual([]);
  });

  it('the stdio transport itself refuses checkout before starting or talking to the MCP', async () => {
    const t = new StdioMcpTransport({ command: process.execPath, args: [join(__dirname, 'fake-mcp.mjs')] } as never);
    await expect(t.callTool('checkout', {})).rejects.toBeInstanceOf(ForbiddenToolError);
    await t.close();
  });

  it('with test mode off, add, update, remove and clear really reach the account', async () => {
    const inner = new Recorder();
    const writer = new CartWriter(new ContinenteMcp(new TestModeGuard(inner, () => false)), () => false);
    await writer.addItem('4421406', 1);
    await writer.setQuantity('4421406', 3);
    await writer.removeItem('4421406');
    await writer.clearCart();
    expect(inner.calls).toEqual(['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart']);
  });

  it('with test mode on, nothing reaches the account', async () => {
    const inner = new Recorder();
    const writer = new CartWriter(new ContinenteMcp(new TestModeGuard(inner, () => true)), () => true);
    await writer.addItem('4421406', 1);
    await writer.clearCart();
    expect(inner.calls).toEqual([]);
  });
});
