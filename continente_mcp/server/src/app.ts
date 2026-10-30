import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { TokenStore, type TokenRecord } from './auth.js';
import type { Config } from './config.js';

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

  return app;
}
