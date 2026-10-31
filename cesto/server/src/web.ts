import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { extname, join } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
/** Only these files are served: no path traversal possible. */
const WEB_FILES = /^(index\.html|app\.js|style\.css|i18n\/(pt-PT|en)\.json)$/;

export interface WebOptions {
  webDir: string;
  vncPort: number;
  isIngressAddress: (ip: string | undefined) => boolean;
  vncActive: () => boolean;
}

/** Ingress page (static files, no build step) and the noVNC proxy to websockify while a sign-in is open. */
export function registerWeb(app: FastifyInstance, o: WebOptions): void {
  const send = (file: string, reply: FastifyReply) => {
    const path = join(o.webDir, file);
    if (!WEB_FILES.test(file) || !existsSync(path)) return reply.code(404).send({ error: { code: 'not_found', message_key: 'error.not_found' } });
    return reply.type(TYPES[extname(file)] ?? 'application/octet-stream').header('cache-control', 'no-store').send(readFileSync(path));
  };
  app.get('/', (_req, reply) => send('index.html', reply));
  app.get<{ Params: { '*': string } }>('/web/*', (req, reply) => send(req.params['*'], reply));

  // noVNC's own files, served by websockify --web.
  app.get<{ Params: { '*': string } }>('/vnc/*', (req, reply) => {
    if (!o.vncActive()) return reply.code(409).send({ error: { code: 'login_inactive', message_key: 'error.login_inactive' } });
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstream = request({ host: '127.0.0.1', port: o.vncPort, path: '/' + req.params['*'] + query, method: 'GET' }, res => {
      reply.code(res.statusCode ?? 502).header('content-type', res.headers['content-type'] ?? 'application/octet-stream').send(res);
    });
    upstream.on('error', () => reply.code(502).send({ error: { code: 'bad_gateway', message_key: 'error.vnc_unavailable' } }));
    upstream.end();
    return reply;
  });

  // WebSocket upgrade for the VNC stream: raw TCP pipe to websockify, ingress only, only while signing in.
  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/vnc/') || !o.isIngressAddress(req.socket.remoteAddress) || !o.vncActive()) { socket.destroy(); return; }
    const upstream = connect(o.vncPort, '127.0.0.1', () => {
      const lines = [`GET ${url.slice(4)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
  });
}
