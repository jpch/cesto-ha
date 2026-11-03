import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
/** Only these files are served: no path traversal possible. */
const WEB_FILES = /^(index\.html|app\.js|style\.css|i18n\/(pt-PT|en)\.json)$/;

export interface WebOptions {
  webDir: string;
}

/** Ingress page (static files, no build step). 2.0.0: sign-in (noVNC) moved to the Continente MCP add-on. */
export function registerWeb(app: FastifyInstance, o: WebOptions): void {
  const send = (file: string, reply: FastifyReply) => {
    const path = join(o.webDir, file);
    if (!WEB_FILES.test(file) || !existsSync(path)) return reply.code(404).send({ error: { code: 'not_found', message_key: 'error.not_found' } });
    return reply.type(TYPES[extname(file)] ?? 'application/octet-stream').header('cache-control', 'no-store').send(readFileSync(path));
  };
  app.get('/', (_req, reply) => send('index.html', reply));
  app.get<{ Params: { '*': string } }>('/web/*', (req, reply) => send(req.params['*'], reply));
}
