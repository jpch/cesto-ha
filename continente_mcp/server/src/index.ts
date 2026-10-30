import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { StdioMcpTransport } from './mcp/client.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from './mcp/continente.js';
import { JobQueue } from './queue.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(join(config.dataDir, 'app.db'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// The MCP process starts lazily on the first call. Every call passes the test-mode guard.
const transport = new StdioMcpTransport({ command: process.env.MCP_COMMAND ?? 'continentept-mcp' });
const testMode = () => config.testMode;
export const mcp = new ContinenteMcp(new TestModeGuard(transport, testMode));
export const cartWriter = new CartWriter(mcp, testMode);
export const queue = new JobQueue();

const app = buildApp({ config, db, version, queueLength: () => queue.length, sessionValid: () => mcp.sessionValid });
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`[continente-mcp] API listening on ${config.port} (test_mode=${config.testMode})`);

const shutdown = async () => { await app.close(); await transport.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
