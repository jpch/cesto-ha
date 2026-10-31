#!/usr/bin/env node
// Fake continentept-mcp for tests: speaks MCP over stdio, records every tool call it receives
// (JSON lines in FAKE_MCP_LOG) and never talks to Continente.
// FAKE_MCP_MODE: "ok" (default) | "not_authenticated" | "crash_once" (exits on the first call
// of each process until FAKE_MCP_STATE exists).
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = ['search_products', 'get_product', 'get_product_labels', 'choose_products', 'list_favorites', 'get_cart',
  'preview_cart_changes', 'add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart', 'list_orders',
  'get_order', 'list_frequently_bought_products', 'get_session_status'];
const mode = process.env.FAKE_MCP_MODE ?? 'ok';
const server = new Server({ name: 'fake-continentept-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify({ name, args, pid: process.pid }) + '\n');
  if (mode === 'crash_once' && !existsSync(process.env.FAKE_MCP_STATE)) {
    writeFileSync(process.env.FAKE_MCP_STATE, 'crashed');
    process.exit(1);
  }
  let result;
  if (mode === 'not_authenticated' && name !== 'search_products') {
    result = { status: 'error', error: { code: 'not_authenticated', message: 'sign in', retryable: false } };
  } else if (name === 'search_products') {
    result = { status: 'success', data: { products: [{ productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa' }] } };
  } else if (TOOLS.includes(name)) {
    result = { status: 'success', data: { tool: name, outcome: name.includes('cart_item') || name === 'clear_cart' ? 'confirmed' : undefined } };
  } else {
    result = { status: 'error', error: { code: 'invalid_input', message: 'unknown tool' } };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result }, isError: result.status === 'error' };
});

await server.connect(new StdioServerTransport());
