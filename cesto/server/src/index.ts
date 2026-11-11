import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { ContinenteLink } from './continente-link.js';
import { openDatabase } from './db.js';
import { HaIntegration, listStats } from './ha.js';
import { HttpMcpTransport, type McpTransport } from './mcp/client.js';
import { CartWriter, ContinenteMcp, TestModeGuard } from './mcp/continente.js';
import { JobQueue } from './queue.js';
import { LogLimiter, Metrics, RepeatedFailureLog, TimedTransport } from './metrics.js';
import { CachedCatalog } from './cache.js';
import { SessionKeepAlive } from './keepalive.js';
import { continenteConnector } from './connectors/continente.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(join(config.dataDir, 'app.db'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// 2.0.0: the Continente account, session, sign-in and browser live in the Continente MCP add-on; Cesto calls
// it over streamable HTTP with its own token. For local runs, point `continente_mcp_url` at any MCP endpoint.
const link = new ContinenteLink({
  dataDir: config.dataDir, shareDir: config.shareDir ?? '', url: config.continenteMcpUrl, token: config.continenteMcpToken,
  log: line => console.log(line),
});
const transport: McpTransport = new HttpMcpTransport({
  endpoint: () => link.endpoint()?.url ?? null, token: () => link.token, onAuth: ok => link.noteAuth(ok), clientVersion: version,
});
const testMode = () => config.testMode;
// Timing instrumentation (1.5.0): stdout only (Supervisor rotates it), capped at 60 lines a minute.
const logLimiter = new LogLimiter(line => console.log(line), 60, 60_000);
const metrics = new Metrics(logLimiter, config.logLevel === 'debug');
export const mcp = new ContinenteMcp(new TestModeGuard(new TimedTransport(transport, metrics), testMode));
export const cartWriter = new CartWriter(mcp, testMode);
export const queue = new JobQueue((info, job) => metrics.job(info, job));
// Catalogue reads go through a TTL cache; cart reads, previews and writes never do.
const catalog = new CachedCatalog(mcp, { onHit: tool => metrics.cacheHit(tool) });

const checkSession = async () => {
  await queue.run(() => mcp.getCart(), { priority: 'background', label: 'session_check' }).catch(() => undefined);
  return mcp.sessionValid;
};
// The Continente MCP add-on's health (every 30 s, public, no secrets): availability, session and sign-in.
// A session change seen there (e.g. after a sign-in on its page) is adopted here too.
let lastRemoteSession: boolean | null = null;
// A persistent purge failure (e.g. a read-only file) was logged every 30 s; now once, hourly, and on recovery.
const purgeLog = new RepeatedFailureLog(line => console.log(line), '[continente] removing the old Continente data');
const pollLink = async () => {
  try { link.handOffSession(); } catch (e) { console.log(`[continente] session hand-off failed: ${(e as Error).message}`); }
  const h = await link.refresh();
  try { link.purgeLegacyData(); purgeLog.ok(); } catch (e) { purgeLog.failed((e as Error).message); }
  const v = typeof h?.session_valid === 'boolean' ? h.session_valid : null;
  if (v !== null && v !== lastRemoteSession) { lastRemoteSession = v; if (v !== mcp.sessionValid) { catalog.clear(); void checkSession(); } }
  publishHa();
};
// Home Assistant entities and the session-expired notification (Supervisor API).
const ha = process.env.SUPERVISOR_TOKEN
  ? new HaIntegration({
    supervisorUrl: 'http://supervisor', token: process.env.SUPERVISOR_TOKEN, language: config.language, log: m => console.log(m),
    continenteSlug: () => link.status().addon_slug,
  })
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
  remoteCartLog: line => logLimiter.log(line),
  onListChanged: publishHa,
  connectors: [continente],
  runJob: (job, options) => queue.run(job, options),
  metrics: () => metrics.snapshot({ length: queue.length, waiting: queue.waiting() }, catalog.stats()),
  sessionEvents: mcp,
  config, db, version, checkSession,
  continente: () => link.status(),
  queueLength: () => queue.length,
  sessionValid: () => mcp.sessionValid,
});
await app.listen({ host: '0.0.0.0', port: config.port });
// Light read-only session check every 20-30 min with jitter; HA notifies when a sign-in is needed.
const keepAlive = new SessionKeepAlive({
  check: checkSession,
  sessionValid: () => mcp.sessionValid,
  signingIn: () => link.status().signing_in,
  idleMs: () => metrics.idleMs(),
  log: line => logLimiter.log(line),
});
keepAlive.start();
void pollLink();
setInterval(() => void pollLink(), 30_000).unref();
console.log(`[cesto] API listening on ${config.port} (test_mode=${config.testMode}, continente_mcp=${link.endpoint()?.source ?? 'not found'})`);

const shutdown = async () => { keepAlive.stop(); await app.close(); await transport.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
