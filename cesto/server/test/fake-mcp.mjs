// Fake Continente MCP add-on for tests: stateless streamable HTTP on 127.0.0.1, Bearer token, records every
// tool call it receives and never talks to Continente.
// mode: "ok" (default) | "not_authenticated" | "drop_once" (drops the connection of the first tool call).
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const TOOLS = ['search_products', 'get_product', 'get_product_labels', 'choose_products', 'list_favorites', 'get_cart',
  'preview_cart_changes', 'add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart', 'list_orders',
  'get_order', 'list_frequently_bought_products', 'get_session_status'];
export const FAKE_TOKEN = 'cmcp_fake-test-token';

function result(mode, name) {
  if (mode === 'not_authenticated' && name !== 'search_products') return { status: 'error', error: { code: 'not_authenticated', message: 'sign in', retryable: false } };
  if (name === 'search_products') return { status: 'success', data: { products: [{ productId: '4421406', name: 'Leite UHT Meio Gordo Mimosa' }] } };
  if (TOOLS.includes(name)) return { status: 'success', data: { tool: name, outcome: name.includes('cart_item') || name === 'clear_cart' ? 'confirmed' : undefined } };
  return { status: 'error', error: { code: 'invalid_input', message: 'unknown tool' } };
}

/** Starts the fake add-on; `calls` lists every tool call that reached it (dropped ones included), `clients` every initialize clientInfo. */
export async function startFakeMcp({ mode = 'ok', token = FAKE_TOKEN } = {}) {
  const calls = [];
  const clients = [];
  let dropped = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body?.method === 'initialize') clients.push(body.params?.clientInfo ?? null);
    if (body?.method === 'tools/call') {
      calls.push({ name: body.params?.name, args: body.params?.arguments ?? {} });
      if (mode === 'drop_once' && !dropped) { dropped = true; req.socket.destroy(); return; }
    }
    const mcp = new Server({ name: 'fake-continente-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async r => {
      const out = result(mode, r.params.name);
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: { result: out }, isError: out.status === 'error' };
    });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(t);
    await t.handleRequest(req, res, body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, token, calls, clients, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
