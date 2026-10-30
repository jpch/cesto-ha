// Headless smoke test: starts continentept-mcp over stdio and calls the read-only
// search_products tool. It never calls a cart tool and never signs in.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'continentept-mcp', env: { ...process.env } });
const client = new Client({ name: 'continente-mcp-ha-smoke', version: '0.1.0' });
const started = Date.now();
await client.connect(transport);
const result = await client.callTool({ name: 'search_products', arguments: { query: 'leite', limit: 3 } });
const status = result.structuredContent?.result?.status;
const products = result.structuredContent?.result?.data?.products ?? [];
console.log(JSON.stringify({ isError: !!result.isError, status, count: products.length,
  first: products[0]?.name ?? null, ms: Date.now() - started }));
if (!result.isError && products.length === 0) console.log(JSON.stringify(result).slice(0, 2000));
await client.close();
process.exit(result.isError || products.length === 0 ? 1 : 0);
