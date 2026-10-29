import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { TokenStore, type TokenRecord } from './auth.js';
import type { Config } from './config.js';
import { ListService, ValidationError, type ItemInput } from './lists.js';
import { parseList } from './parser.js';

declare module 'fastify' {
  interface FastifyRequest { principal?: TokenRecord }
}

export interface AppDeps { config: Config; db: DatabaseSync; version: string; queueLength?: () => number; sessionValid?: () => boolean | null }

/** Error bodies carry a message key, never user-facing text, so clients localise them. */
export const apiError = (code: string, messageKey: string) => ({ error: { code, message_key: messageKey } });

const PUBLIC_ROUTES = new Set(['/api/v1/health', '/api/v1/openapi.yaml']);

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.config.logLevel === 'debug' ? { level: 'debug' } : false });
  const tokens = new TokenStore(deps.db);
  const isIngress = (req: FastifyRequest) => req.ip === deps.config.ingressAddress;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/v1/') || PUBLIC_ROUTES.has(path)) return;
    if (path.startsWith('/api/v1/admin/')) {
      if (!isIngress(req)) return reply.code(403).send(apiError('forbidden', 'error.admin_ingress_only'));
      return;
    }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const principal = match ? tokens.verify(match[1]!) : undefined;
    if (!principal) return reply.code(401).send(apiError('unauthorized', 'error.unauthorized'));
    req.principal = principal;
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
    if (typeof name !== 'string' || !name.trim() || (kind !== 'phone' && kind !== 'app'))
      return reply.code(400).send(apiError('invalid_request', 'error.invalid_token_request'));
    const created = tokens.create(name.trim(), kind);
    return reply.code(201).send({ token: created.token, ...created.record });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/admin/tokens/:id', async (req, reply) =>
    tokens.revoke(Number(req.params.id)) ? reply.code(204).send() : reply.code(404).send(apiError('not_found', 'error.token_not_found')));

  const lists = new ListService(deps.db);
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send(apiError('invalid_request', error.key));
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
