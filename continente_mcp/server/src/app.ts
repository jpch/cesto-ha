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
import { itemKey, type CatalogReader } from './catalog.js';
import { ProductSearch, SearchError } from './search.js';
import { HabitsService, PreferenceStore } from './habits.js';
import { Matcher } from './matcher.js';
import { parseList } from './parser.js';
import { ProposalError, ProposalService } from './proposals.js';
import { BasketService, type CartApi } from './basket.js';
import { createProvider, PhotoError, PhotoService, type PhotoInput } from './vision.js';
import type { EventEmitter } from 'node:events';
import { createAiClient, type AiClient } from './ai.js';
import { PromotionService } from './promotions.js';

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
  /** Read-only Continente catalogue (ContinenteMcp); matching routes return 503 without it. */
  catalog?: CatalogReader;
  /** Runs an MCP job through the single-worker queue. */
  runJob?: <T>(job: () => Promise<T>) => Promise<T>;
  /** Delays before each cart read-back after applying (default VERIFY_DELAYS_MS); tests use zeros. */
  verifyDelaysMs?: number[];
  /** Cart reads plus the test-mode-guarded CartWriter. */
  cart?: CartApi;
  /** Emits `session` (boolean); waiting apply jobs resume on `true`. */
  sessionEvents?: EventEmitter;
  /** Overrides the AI client built from config.ai (tests). */
  ai?: AiClient | null;
  webDir?: string;
  vncPort?: number;
}

/** Error bodies carry a message key, never user-facing text, so clients localise them. */
export const apiError = (code: string, messageKey: string) => ({ error: { code, message_key: messageKey } });

const PUBLIC_ROUTES = new Set(['/api/v1/health', '/api/v1/openapi.yaml']);

/**
 * Routes reachable through Home Assistant ingress, which is also the remote path (external HA URL).
 * Only the shared list API: never the cart, basket, jobs, photos, promotions, preferences or habits.
 */
export const REMOTE_ROUTE = /^\/api\/v1\/(health|openapi\.yaml|me|lists(\/current(\/changes|\/items|\/parse|\/clear)?|\/history(\/\d+\/repeat)?)?|items\/\d+)$/;

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
      // panel_admin is false so non-admin HA users can use the list remotely; the add-on page stays admin-only.
      // Supervisor strips client-sent X-Remote-* headers and sets them from the session user.
      const groups = req.headers['x-remote-user-groups'];
      if (req.headers['x-remote-user-id'] && !(typeof groups === 'string' && groups.split(',').includes('system-admin')))
        return reply.code(403).send(apiError('forbidden', 'error.admin_only'));
      return;
    }
    const viaHa = isIngress(req);
    if (viaHa && !REMOTE_ROUTE.test(path)) return reply.code(403).send(apiError('forbidden', 'error.remote_forbidden'));
    if (PUBLIC_ROUTES.has(path)) return;
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    let principal = match ? tokens.verify(match[1]!) : undefined;
    // Through ingress, Home Assistant has already authenticated the user (HA session or long-lived token).
    const haUser = req.headers['x-remote-user-id'];
    if (!principal && viaHa && typeof haUser === 'string' && haUser) {
      const name = [req.headers['x-remote-user-display-name'], req.headers['x-remote-user-name']].find(v => typeof v === 'string' && v.trim()) as string | undefined;
      principal = { id: 0, name: (name ?? 'Home Assistant').trim().slice(0, 60), kind: 'ha', created_at: '', last_used_at: null, revoked_at: null };
    }
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
    if (error instanceof PhotoError) return reply.code(error.status).send(apiError('invalid_request', error.key));
    if (error instanceof SearchError) return reply.code(error.status).send(apiError(error.status === 409 ? 'conflict' : error.status === 502 ? 'upstream' : 'invalid_request', error.key));
    if (error instanceof ProposalError) return reply.code(error.status).send(apiError(error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict' : 'invalid_request', error.key));
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

  // --- Matching, habits and shared preferences ---
  const prefs = new PreferenceStore(deps.db);
  const runJob = deps.runJob ?? (<T>(job: () => Promise<T>) => job());
  const catalog = deps.catalog;
  const habits = catalog ? new HabitsService(deps.db, catalog) : undefined;
  const proposals = catalog && habits ? new ProposalService(deps.db, lists, catalog, new Matcher(catalog, prefs), habits) : undefined;
  const needCatalog = () => { if (!proposals || !habits) throw new ProposalError(503, 'error.mcp_unavailable'); return { proposals, habits }; };

  app.post<{ Body: { item_ids?: unknown } }>('/api/v1/basket/proposals', async (req, reply) => {
    const ids = req.body?.item_ids;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(Number.isInteger))) return reply.code(400).send(apiError('invalid_request', 'error.invalid_request'));
    const { proposals } = needCatalog();
    return reply.code(201).send(await runJob(() => proposals.create(req.principal!.name, ids as number[] | undefined)));
  });

  app.get<{ Params: { id: string } }>('/api/v1/basket/proposals/:id', async (req, reply) => {
    const p = needCatalog().proposals.get(req.params.id);
    return p ?? reply.code(404).send(apiError('not_found', 'error.proposal_not_found'));
  });

  app.patch<{ Params: { id: string; item_id: string }; Body: { product_id?: unknown; quantity?: unknown; skip?: unknown } }>(
    '/api/v1/basket/proposals/:id/lines/:item_id',
    async req => { const { proposals } = needCatalog(); return runJob(() => proposals.choose(req.params.id, Number(req.params.item_id), req.body ?? {})); });

  const basket = proposals && deps.cart ? new BasketService(deps.db, lists, proposals, deps.cart, prefs, () => deps.config.testMode, runJob, deps.verifyDelaysMs) : undefined;
  deps.sessionEvents?.on('session', (valid: boolean) => { if (valid) basket?.resumeWaiting(); });
  const needBasket = () => { if (!basket) throw new ProposalError(503, 'error.mcp_unavailable'); return basket; };

  app.post<{ Params: { id: string }; Body: { mode?: unknown } }>('/api/v1/basket/proposals/:id/preview', async (req, reply) => {
    const mode = req.body?.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') return reply.code(400).send(apiError('invalid_request', 'error.invalid_mode'));
    const b = needBasket();
    return runJob(() => b.preview(req.params.id, mode));
  });

  app.post<{ Params: { id: string }; Body: { preview_id?: unknown } }>('/api/v1/basket/proposals/:id/apply', async (req, reply) =>
    reply.code(202).send(needBasket().apply(req.params.id, req.body?.preview_id)));

  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/retry-missing', async (req, reply) =>
    reply.code(202).send(needBasket().retryMissing(req.params.id)));

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req, reply) =>
    needBasket().job(req.params.id) ?? reply.code(404).send(apiError('not_found', 'error.job_not_found')));

  const photos = catalog ? new PhotoService(deps.config.dataDir, catalog, createProvider(deps.config.visionProvider)) : undefined;
  const needPhotos = () => { if (!photos) throw new ProposalError(503, 'error.mcp_unavailable'); return photos; };

  app.post<{ Body: PhotoInput }>('/api/v1/photos', { bodyLimit: 12 * 1024 * 1024 }, async req => {
    const ph = needPhotos();
    return runJob(() => ph.identify(req.body ?? {}));
  });
  app.get<{ Params: { id: string } }>('/api/v1/photos/:id/thumbnail', async (req, reply) => {
    const t = needPhotos().thumbnail(req.params.id);
    if (!t) return reply.code(404).send(apiError('not_found', 'error.photo_not_found'));
    return reply.type(t[0] === 0xff ? 'image/jpeg' : 'image/png').send(t);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/photos/:id', async (req, reply) =>
    needPhotos().remove(req.params.id) ? reply.code(204).send() : reply.code(404).send(apiError('not_found', 'error.photo_not_found')));

  app.get('/api/v1/preferences', async () => ({ preferences: prefs.list() }));

  app.put<{ Params: { key: string }; Body: { product_id?: unknown; quantity?: unknown } }>('/api/v1/preferences/:key', async (req, reply) => {
    const { product_id, quantity } = req.body ?? {};
    const key = itemKey(req.params.key);
    if (!key || typeof product_id !== 'string' || !/^\d{1,20}$/.test(product_id) || (quantity != null && (typeof quantity !== 'number' || !(quantity > 0))))
      return reply.code(400).send(apiError('invalid_request', 'error.invalid_preference'));
    return prefs.set(key, product_id, (quantity as number | null | undefined) ?? null, req.principal!.name);
  });

  app.delete<{ Params: { key: string } }>('/api/v1/preferences/:key', async (req, reply) =>
    prefs.remove(itemKey(req.params.key)) ? reply.code(204).send() : reply.code(404).send(apiError('not_found', 'error.preference_not_found')));

  const ai = deps.ai !== undefined ? deps.ai : createAiClient(deps.config.ai);
  const promotions = catalog ? new PromotionService(catalog, ai, deps.config.language) : undefined;
  app.get('/api/v1/promotions', async () => {
    if (!promotions) throw new ProposalError(503, 'error.mcp_unavailable');
    const list = lists.current();
    return runJob(() => promotions.suggest(lists.items(list.id)));
  });

  const search = catalog ? new ProductSearch(catalog) : undefined;
  app.post<{ Body: { query?: unknown; barcode?: unknown } }>('/api/v1/catalog/search', async req => {
    if (!search) throw new ProposalError(503, 'error.mcp_unavailable');
    return runJob(() => search.search(req.body ?? {}));
  });

  app.get('/api/v1/habits', async () => needCatalog().habits.get());

  app.post('/api/v1/habits/refresh', async () => { const { habits } = needCatalog(); return runJob(() => habits.refresh()); });

  return app;
}
