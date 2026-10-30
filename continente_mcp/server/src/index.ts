import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { CredentialsStore } from './credentials.js';
import { openDatabase } from './db.js';
import { HaIntegration, listStats } from './ha.js';
import { LoginService } from './login.js';
import { StdioMcpTransport } from './mcp/client.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from './mcp/continente.js';
import { JobQueue } from './queue.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(join(config.dataDir, 'app.db'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// The MCP process starts lazily on the first call. Every call passes the test-mode guard.
const mcpCommand = process.env.MCP_COMMAND ?? 'continentept-mcp';
const transport = new StdioMcpTransport({ command: mcpCommand });
const testMode = () => config.testMode;
export const mcp = new ContinenteMcp(new TestModeGuard(transport, testMode));
export const cartWriter = new CartWriter(mcp, testMode);
export const queue = new JobQueue();

const credentials = new CredentialsStore(config.dataDir);

// On-demand sign-in with a visible browser on a virtual display, viewed through noVNC on the ingress page.
const VNC_PORT = 5999;
const WS_PORT = 6080;
const login = new LoginService({
  display: { command: 'Xvnc', args: [':99', '-geometry', '1280x860', '-depth', '24', '-SecurityTypes', 'None', '-localhost', 'yes', '-rfbport', String(VNC_PORT), '-AlwaysShared'] },
  websockify: { command: 'websockify', args: ['--web', '/usr/share/novnc', `127.0.0.1:${WS_PORT}`, `127.0.0.1:${VNC_PORT}`] },
  login: { command: mcpCommand, args: ['login', '--show-browser'] },
  env: { DISPLAY: ':99' },
});
// A new session or account is only read by a fresh MCP process.
const restartMcp = () => { void transport.close(); };
const checkSession = async () => {
  await queue.run(() => mcp.getCart()).catch(() => undefined);
  return mcp.sessionValid;
};
login.on('success', () => { restartMcp(); void checkSession(); });

// Home Assistant entities and the session-expired notification (Supervisor API).
const ha = process.env.SUPERVISOR_TOKEN
  ? new HaIntegration({ supervisorUrl: 'http://supervisor', token: process.env.SUPERVISOR_TOKEN, language: config.language, log: m => console.log(m) })
  : undefined;
let haTimer: NodeJS.Timeout | undefined;
const publishHa = () => {
  if (!ha) return;
  clearTimeout(haTimer);
  haTimer = setTimeout(() => {
    void ha.publish({ version, testMode: config.testMode, sessionValid: mcp.sessionValid, queueLength: queue.length, ...listStats(db) });
  }, 500);
};
mcp.on('session', publishHa);
if (ha) { publishHa(); setInterval(publishHa, 60_000).unref(); }

const app = buildApp({
  onListChanged: publishHa,
  catalog: mcp,
  runJob: job => queue.run(job),
  cart: {
    getCart: () => mcp.getCart(),
    previewCartChanges: items => mcp.previewCartChanges(items),
    setQuantity: (productId, quantity) => cartWriter.setQuantity(productId, quantity),
    clearCart: () => cartWriter.clearCart(),
  },
  sessionEvents: mcp,
  config, db, version, credentials, login, checkSession,
  queueLength: () => queue.length,
  sessionValid: () => mcp.sessionValid,
  onCredentialsChanged: restartMcp,
  vncPort: WS_PORT,
});
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`[continente-mcp] API listening on ${config.port} (test_mode=${config.testMode})`);

const shutdown = async () => { login.cancel(); await app.close(); await transport.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
