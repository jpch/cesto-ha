import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { TokenStore, type TokenRecord } from './auth.js';
import type { Config } from './config.js';
import { CredentialsError, CredentialsStore } from './credentials.js';
import { exportData } from './export.js';
import type { LoginService } from './login.js';
import { registerWeb } from './web.js';
import { ListService, ValidationError, type ItemInput } from './lists.js';
import { parseList } from './parser.js';

declare module 'fastify' {
  interface FastifyRequest { principal?: TokenRecord }
}

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  version: string;
  queueLength?: () => number;
  sessionValid?: () => boolean | null;
  credentials?: CredentialsStore;
  login?: LoginService;
  /** Read-only account call that refreshes the session state. */
  checkSession?: () => Promise<boolean | null>;
  /** Called after the Continente account changes (the MCP process must restart to read it). */
  onCredentialsChanged?: () => void;
  /** Called after a successful write to the shared list (HA sensors). */
  onListChanged?: () => void;
  webDir?: string;
  vncPort?: number;
}

/** Error bodies carry a message key, never user-facing text, so clients localise them. */
export const apiError = (code: string, messageKey: string) => ({ error: { code, message_key: messageKey } });

const PUBLIC_ROUTES = new Set(['/api/v1/health', '/api/v1/openapi.yaml']);

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.logLevel === 'debug' ? { level: 'debug' } : false });
  const tokens = new TokenStore(deps.db);
  const credentials = deps.credentials ?? new CredentialsStore(deps.config.dataDir);
  const isIngressAddress = (ip: string | undefined) => ip === deps.config.ingressAddress || ip === `::ffff:${deps.config.ingressAddress}`;
  const isIngress = (req: FastifyRequest) => isIngressAddress(req.ip);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    // The web page, noVNC and admin routes are only reachable through Home Assistant ingress.
    if (!path.startsWith('/api/v1/') || path.startsWith('/api/v1/admin/')) {
      if (!isIngress(req)) return reply.code(403).send(apiError('forbidden', 'error.admin_ingress_only'));
      return;
    }
    if (PUBLIC_ROUTES.has(path)) return;
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const principal = match ? tokens.verify(match[1]!) : undefined;
    if (!principal) return reply.code(401).send(apiError('unauthorized', 'error.unauthorized'));
    req.principal = principal;
  });

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (req.method !== 'GET' && reply.statusCode < 400 && /^\/api\/v1\/(lists|items)(\/|$)/.test(path) && !path.endsWith('/parse')) deps.onListChanged?.();
  });

  app.get('/api/v1/health', async () => ({
    version: deps.version,
    test_mode: deps.config.testMode,
    session_valid: deps.sessionValid?.() ?? null,
    queue_length: deps.queueLength?.() ?? 0,
  }));

  app.get('/api/v1/openapi.yaml', async (_req, reply) =>
    reply.type('application/yaml').send(readFileSync(new URL('../openapi.yaml', import.meta.url))));

  app.get('/api/v1/me', async req => ({ id: req.principal!.id, name: req.principal!.name, kind: req.principal!.kind }));

  app.get('/api/v1/admin/tokens', async () => ({ tokens: tokens.list() }));

  app.post<{ Body: { name?: unknown; kind?: unknown } }>('/api/v1/admin/tokens', async (req, reply) => {
    const { name, kind } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || (kind !== 'phone' && kind !== 'app'))
      return reply.code(400).send(apiError('invalid_request', 'error.invalid_token_request'));
    const created = tokens.create(name.trim(), kind);
    return reply.code(201).send({ token: created.token, ...created.record });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/admin/tokens/:id', async (req, reply) =>
    tokens.revoke(Number(req.params.id)) ? reply.code(204).send() : reply.code(404).send(apiError('not_found', 'error.token_not_found')));

  const loginStatus = () => ({ state: deps.login?.state ?? 'idle', started_at: deps.login?.startedAt ?? null, available: !!deps.login });

  app.get('/api/v1/admin/status', async () => ({
    version: deps.version,
    test_mode: deps.config.testMode,
    language: deps.config.language,
    session_valid: deps.sessionValid?.() ?? null,
    queue_length: deps.queueLength?.() ?? 0,
    credentials: credentials.status(),
    login: loginStatus(),
  }));

  app.put<{ Body: { email?: unknown; password?: unknown } }>('/api/v1/admin/credentials', async (req, reply) => {
    credentials.save(req.body?.email, req.body?.password);
    deps.onCredentialsChanged?.();
    return reply.code(204).send();
  });

  app.delete('/api/v1/admin/credentials', async (_req, reply) => {
    if (!credentials.remove()) return reply.code(404).send(apiError('not_found', 'error.credentials_missing'));
    deps.onCredentialsChanged?.();
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/login', async () => loginStatus());

  app.post('/api/v1/admin/login', async (_req, reply) => {
    if (!deps.login) return reply.code(503).send(apiError('unavailable', 'error.login_unavailable'));
    if (!credentials.status().configured) return reply.code(409).send(apiError('credentials_missing', 'error.credentials_missing'));
    deps.login.start();
    return reply.code(202).send(loginStatus());
  });

  app.delete('/api/v1/admin/login', async (_req, reply) => { deps.login?.cancel(); return reply.code(204).send(); });

  app.post('/api/v1/admin/session/check', async () => ({ session_valid: deps.checkSession ? await deps.checkSession() : null }));

  app.get('/api/v1/admin/export', async (_req, reply) => {
    const date = new Date().toISOString().slice(0, 10);
    return reply.header('content-disposition', `attachment; filename="continente-export-${date}.json"`).send(exportData(deps.db, deps.version));
  });

  registerWeb(app, {
    webDir: deps.webDir ?? fileURLToPath(new URL('../web', import.meta.url)),
    vncPort: deps.vncPort ?? 6080,
    isIngressAddress,
    vncActive: () => deps.login?.active ?? false,
  });

  const lists = new ListService(deps.db);
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ValidationError || error instanceof CredentialsError) return reply.code(400).send(apiError('invalid_request', error.key));
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.code(status).send(apiError('invalid_request', 'error.invalid_request'));
    app.log.error(error);
    return reply.code(500).send(apiError('internal', 'error.internal'));
  });

  const snapshot = () => {
    const list = lists.current();
    return { list, version: lists.currentVersion(), items: lists.items(list.id) };
  };

  app.get('/api/v1/lists/current', async () => snapshot());

  app.get<{ Querystring: { since?: string } }>('/api/v1/lists/current/changes', async (req, reply) => {
    const since = Number(req.query.since);
    if (!Number.isInteger(since) || since < 0) return reply.code(400).send(apiError('invalid_request', 'error.invalid_since'));
    const list = lists.current();
    return { list, version: lists.currentVersion(), items: lists.items(list.id, since) };
  });

  app.post<{ Body: ItemInput }>('/api/v1/lists/current/items', async (req, reply) => {
    const { item, created } = lists.add(req.body ?? {}, req.principal!.name);
    return reply.code(created ? 201 : 200).send(item);
  });

  app.patch<{ Params: { id: string }; Body: ItemInput }>('/api/v1/items/:id', async (req, reply) => {
    const res = lists.update(Number(req.params.id), req.body ?? {});
    if (!res) return reply.code(404).send(apiError('not_found', 'error.item_not_found'));
    return { ...res.item, applied: res.applied };
  });

  app.delete<{ Params: { id: string }; Querystring: { updated_at?: string } }>('/api/v1/items/:id', async (req, reply) => {
    const res = lists.remove(Number(req.params.id), req.query.updated_at);
    if (!res) return reply.code(404).send(apiError('not_found', 'error.item_not_found'));
    return res.applied ? reply.code(204).send() : reply.code(409).send(apiError('stale_write', 'error.stale_write'));
  });

  app.post<{ Body: { text?: unknown } }>('/api/v1/lists/current/parse', async (req, reply) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || text.length > 20000) return reply.code(400).send(apiError('invalid_request', 'error.invalid_text'));
    return { items: parseList(text) };
  });

  app.post<{ Body: { scope?: unknown } }>('/api/v1/lists/current/clear', async (req, reply) => {
    const scope = req.body?.scope;
    if (scope !== 'in_cart' && scope !== 'all') return reply.code(400).send(apiError('invalid_request', 'error.invalid_scope'));
    return { cleared: lists.clear(scope), version: lists.currentVersion() };
  });

  app.post('/api/v1/lists', async (_req, reply) => { lists.startNew(); return reply.code(201).send(snapshot()); });

  app.get('/api/v1/lists/history', async () => ({ lists: lists.history() }));

  app.post<{ Params: { id: string } }>('/api/v1/lists/history/:id/repeat', async (req, reply) => {
    const items = lists.repeat(Number(req.params.id), req.principal!.name);
    if (!items) return reply.code(404).send(apiError('not_found', 'error.list_not_found'));
    return { items, version: lists.currentVersion() };
  });

  return app;
}
