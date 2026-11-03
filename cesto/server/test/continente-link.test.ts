/**
 * 2.0.0 contract with the Continente MCP add-on (jpch/continente-mcp-ha): discovery through /share, the token
 * request (hash only), the one-time session hand-off and the streamable HTTP transport with the token.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ContinenteLink, fingerprintOf } from '../src/continente-link.js';
import { ContinenteUnavailableError, HttpMcpTransport } from '../src/mcp/client.js';

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'link-'));
  const dataDir = join(root, 'data'), shareDir = join(root, 'share');
  mkdirSync(dataDir); mkdirSync(shareDir);
  return { dataDir, shareDir };
};
const endpoint = (shareDir: string, e: unknown) => writeFileSync(join(shareDir, 'endpoint.json'), JSON.stringify(e));

describe('ContinenteLink', () => {
  it('generates its own token once (0600) and requests it with the hash only', () => {
    const d = dirs();
    const link = new ContinenteLink(d);
    const file = join(d.dataDir, 'continente-mcp', 'token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(link.token).toMatch(/^cmcp_[A-Za-z0-9_-]{43}$/);
    expect(new ContinenteLink(d).token).toBe(link.token);
    link.requestToken();
    const raw = readFileSync(join(d.shareDir, 'requests', 'cesto.json'), 'utf8');
    expect(raw).not.toContain(link.token);
    const req = JSON.parse(raw);
    expect(req).toMatchObject({ name: 'Cesto', priority: true, hash: createHash('sha256').update(link.token).digest('hex') });
    expect(link.status()).toMatchObject({ token: 'pending_approval', fingerprint: fingerprintOf(req.hash), available: false });
    expect(JSON.stringify(link.status())).not.toContain(link.token);
  });

  it('a working token stops the requests; a 401 asks again', () => {
    const d = dirs();
    const link = new ContinenteLink(d);
    link.noteAuth(true);
    expect(link.status().token).toBe('approved');
    expect(new ContinenteLink(d).status().token).toBe('approved');
    link.requestToken();
    expect(existsSync(join(d.shareDir, 'requests', 'cesto.json'))).toBe(false);
    link.noteAuth(false);
    expect(link.status().token).toBe('pending_approval');
    expect(existsSync(join(d.shareDir, 'requests', 'cesto.json'))).toBe(true);
  });

  it('options override discovery and the token request', () => {
    const d = dirs();
    const link = new ContinenteLink({ ...d, url: 'http://example.invalid:8100/mcp', token: 'cmcp_x' });
    expect(link.endpoint()).toEqual({ url: 'http://example.invalid:8100/mcp', source: 'option' });
    link.requestToken();
    expect(existsSync(join(d.shareDir, 'requests'))).toBe(false);
    expect(existsSync(join(d.dataDir, 'continente-mcp', 'token'))).toBe(false);
    expect(link.status().token).toBe('option');
  });

  it('discovers the endpoint from endpoint.json and rejects anything odd', () => {
    const d = dirs();
    const link = new ContinenteLink(d);
    expect(link.endpoint()).toBeNull();
    endpoint(d.shareDir, { hostname: '75545ee1-continente-mcp', port: 8100, mcp_path: '/mcp' });
    expect(link.endpoint()).toEqual({ url: 'http://75545ee1-continente-mcp:8100/mcp', source: 'discovered' });
    for (const bad of [{ hostname: 'evil.example.org', port: 8100 }, { hostname: 'other-addon', port: 8100 }, { hostname: 'a', port: 0 }, { hostname: 'a@b', port: 1 }, 'x']) {
      endpoint(d.shareDir, bad);
      expect(link.endpoint(), JSON.stringify(bad)).toBeNull();
    }
  });

  it('hands off an existing session once, READY last, keeping the local copy', () => {
    const d = dirs();
    const src = join(d.dataDir, 'continente');
    mkdirSync(join(src, 'profile'), { recursive: true });
    writeFileSync(join(src, 'credentials.env'), 'x', { mode: 0o600 });
    writeFileSync(join(src, 'profile', 'Cookies'), 'c');
    const link = new ContinenteLink(d);
    expect(link.handOffSession()).toBe('no_addon');
    endpoint(d.shareDir, { hostname: 'localhost', port: 8100 });
    expect(link.handOffSession()).toBe('handed_off');
    const imp = join(d.shareDir, 'import');
    expect(readdirSync(imp).sort()).toEqual(['READY', 'credentials.env', 'profile']);
    expect(statSync(imp).mode & 0o777).toBe(0o700);
    expect(existsSync(join(src, 'credentials.env'))).toBe(true);
    expect(link.handOffSession()).toBe('done_before');
  });

  it('reads the public health of the add-on', async () => {
    const d = dirs();
    endpoint(d.shareDir, { hostname: 'localhost', port: 8100 });
    const seen: string[] = [];
    const link = new ContinenteLink({ ...d, fetch: (async (u: URL) => { seen.push(String(u)); return new Response(JSON.stringify({ version: '1.0.0', session_valid: false, signing_in: true, addon_slug: '75545ee1_continente_mcp' })); }) as never });
    await link.refresh();
    expect(seen).toEqual(['http://localhost:8100/health']);
    expect(link.status()).toMatchObject({ available: true, session_valid: false, signing_in: true, addon_slug: '75545ee1_continente_mcp', version: '1.0.0' });
  });
});

describe('HttpMcpTransport', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

  /** A stand-in for the Continente MCP add-on: Bearer token, stateless streamable HTTP, JSON answers. */
  async function fakeAddon(token: string, calls: string[]) {
    server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
      const mcp = new McpServer({ name: 'fake', version: '1' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      mcp.setRequestHandler(CallToolRequestSchema, async r => {
        calls.push(r.params.name);
        return { content: [], structuredContent: { result: { status: 'success', data: { items: [], echo: r.params.arguments } } } };
      });
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(t);
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      await t.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}/mcp`;
  }

  it('calls tools with the bearer token and reports auth', async () => {
    const calls: string[] = [], auth: boolean[] = [];
    const url = await fakeAddon('cmcp_good', calls);
    const t = new HttpMcpTransport({ endpoint: () => url, token: () => 'cmcp_good', onAuth: ok => auth.push(ok) });
    expect(await t.callTool('get_cart', {})).toMatchObject({ status: 'success' });
    expect(calls).toEqual(['get_cart']);
    expect(auth.every(Boolean)).toBe(true);
    await t.close();
  });

  it('an unapproved token is unauthorized, never retried', async () => {
    const calls: string[] = [], auth: boolean[] = [];
    const url = await fakeAddon('cmcp_good', calls);
    const t = new HttpMcpTransport({ endpoint: () => url, token: () => 'cmcp_other', onAuth: ok => auth.push(ok) });
    await expect(t.callTool('set_cart_item_quantity', { productId: '1', quantity: 1 })).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(calls).toEqual([]);
    expect(auth).toContain(false);
  });

  it('not installed / unreachable; cart changes are not retried, reads are once', async () => {
    await expect(new HttpMcpTransport({ endpoint: () => null, token: () => 'x' }).callTool('get_cart', {})).rejects.toBeInstanceOf(ContinenteUnavailableError);
    let n = 0;
    const failing = (async () => { n++; throw new TypeError('fetch failed'); }) as never;
    const t = new HttpMcpTransport({ endpoint: () => 'http://127.0.0.1:9/mcp', token: () => 'x', fetch: failing });
    await expect(t.callTool('set_cart_item_quantity', { productId: '1', quantity: 1 })).rejects.toMatchObject({ reason: 'unreachable' });
    const afterWrite = n;
    await expect(t.callTool('get_cart', {})).rejects.toMatchObject({ reason: 'unreachable' });
    expect(n - afterWrite).toBe(2 * (afterWrite));
  });

  it('refuses checkout-like tools before sending anything', async () => {
    const t = new HttpMcpTransport({ endpoint: () => 'http://127.0.0.1:9/mcp', token: () => 'x', fetch: (() => { throw new Error('sent'); }) as never });
    await expect(t.callTool('checkout', {})).rejects.toThrow();
    await expect(t.callTool('checkout', {})).rejects.not.toThrow('sent');
  });
});
