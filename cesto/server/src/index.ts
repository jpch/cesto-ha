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
import { LogLimiter, Metrics, TimedTransport } from './metrics.js';
import { CachedCatalog } from './cache.js';
import { SessionKeepAlive } from './keepalive.js';
import { continenteConnector } from './connectors/continente.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(join(config.dataDir, 'app.db'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// The MCP process starts lazily on the first call. Every call passes the test-mode guard.
const mcpCommand = process.env.MCP_COMMAND ?? 'continentept-mcp';
const transport = new StdioMcpTransport({ command: mcpCommand });
const testMode = () => config.testMode;
// Timing instrumentation (1.5.0): stdout only (Supervisor rotates it), capped at 60 lines a minute.
const logLimiter = new LogLimiter(line => console.log(line), 60, 60_000);
const metrics = new Metrics(logLimiter, config.logLevel === 'debug');
export const mcp = new ContinenteMcp(new TestModeGuard(new TimedTransport(transport, metrics), testMode));
export const cartWriter = new CartWriter(mcp, testMode);
export const queue = new JobQueue((info, job) => metrics.job(info, job));
// Catalogue reads go through a TTL cache; cart reads, previews and writes never do.
const catalog = new CachedCatalog(mcp, { onHit: tool => metrics.cacheHit(tool) });

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
const restartMcp = () => { catalog.clear(); void transport.close(); };
const checkSession = async () => {
  await queue.run(() => mcp.getCart(), { priority: 'background', label: 'session_check' }).catch(() => undefined);
  return mcp.sessionValid;
};
login.on('success', () => { restartMcp(); void checkSession(); });
login.on('failed', () => metrics.signInFailed());

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

// Every supermarket call goes through a connector; cart writes keep passing the test-mode guard.
const continente = continenteConnector(catalog, {
  getCart: () => mcp.getCart(),
  previewCartChanges: items => mcp.previewCartChanges(items),
  setQuantity: (productId, quantity) => cartWriter.setQuantity(productId, quantity),
  clearCart: () => cartWriter.clearCart(),
}, () => mcp.sessionValid);

const app = buildApp({
  accessLog: line => console.log(line),
  onListChanged: publishHa,
  connectors: [continente],
  runJob: (job, options) => queue.run(job, options),
  metrics: () => metrics.snapshot({ length: queue.length, waiting: queue.waiting() }, catalog.stats()),
  sessionEvents: mcp,
  config, db, version, credentials, login, checkSession,
  queueLength: () => queue.length,
  sessionValid: () => mcp.sessionValid,
  onCredentialsChanged: restartMcp,
  vncPort: WS_PORT,
});
await app.listen({ host: '0.0.0.0', port: config.port });
// Light read-only session check every 20-30 min with jitter; HA notifies when a sign-in is needed.
const keepAlive = new SessionKeepAlive({
  check: checkSession,
  sessionValid: () => mcp.sessionValid,
  signingIn: () => login.state === 'starting' || login.state === 'waiting_user',
  idleMs: () => metrics.idleMs(),
  log: line => logLimiter.log(line),
});
keepAlive.start();
console.log(`[cesto] API listening on ${config.port} (test_mode=${config.testMode})`);

const shutdown = async () => { keepAlive.stop(); login.cancel(); await app.close(); await transport.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
