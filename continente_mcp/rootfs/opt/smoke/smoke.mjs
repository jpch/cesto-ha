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
if (result.isError || products.length === 0) process.exit(1);

// API server smoke test (when the server is present in the image).
import { existsSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (existsSync('/opt/server/dist/index.js')) {
  const dataDir = mkdtempSync('/tmp/api-');
  const server = spawn('node', ['dist/index.js'], { cwd: '/opt/server', stdio: 'inherit',
    env: { ...process.env, DATA_DIR: dataDir, OPTIONS_PATH: `${dataDir}/none.json`, PORT: '18099' } });
  let health;
  for (let i = 0; i < 50 && !health; i++) {
    await new Promise(r => setTimeout(r, 200));
    health = await fetch('http://127.0.0.1:18099/api/v1/health').then(r => r.json()).catch(() => undefined);
  }
  const unauth = await fetch('http://127.0.0.1:18099/api/v1/me').then(r => r.status).catch(() => 0);
  server.kill();
  console.log(JSON.stringify({ api_health: health ?? null, unauthenticated_status: unauth }));
  if (!health || health.test_mode !== true || unauth !== 401) process.exit(1);
}
process.exit(0);
