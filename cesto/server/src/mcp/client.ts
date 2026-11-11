import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertAllowedTool, isMutating, type ToolResult } from './tools.js';

/** Low-level transport: sends one tool call to the Continente MCP add-on. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Cesto's own version, read once from package.json (dist/ and src/ both sit next to it). */
export const CLIENT_VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The Continente MCP add-on is not installed, not reachable, or does not accept Cesto's token yet. */
export class ContinenteUnavailableError extends Error {
  constructor(readonly reason: 'not_found' | 'unreachable' | 'unauthorized') { super(`continente_mcp_${reason}`); }
}

export interface HttpOptions {
  /** Current endpoint (re-resolved on every connect; null when the add-on is not found). */
  endpoint: () => string | null;
  token: () => string;
  /** 2xx: true; HTTP 401: false. */
  onAuth?: (ok: boolean) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Sent as the MCP client version (the add-on version from package.json). */
  clientVersion?: string;
}

/**
 * 2.0.0: calls the generic Continente MCP add-on over streamable HTTP with Cesto's own token (priority lane
 * there). Read-only calls are retried once after a connection failure; cart changes never are.
 */
export class HttpMcpTransport implements McpTransport {
  private client?: Client;
  private url?: string;
  constructor(private readonly o: HttpOptions) {}

  private authFetch(): typeof fetch {
    const base = this.o.fetch ?? fetch;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${this.o.token()}`);
      const res = await base(input, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 120_000) });
      if (res.status === 401) this.o.onAuth?.(false);
      else if (res.ok) this.o.onAuth?.(true);
      return res;
    }) as typeof fetch;
  }

  private async connect(): Promise<Client> {
    const url = this.o.endpoint();
    if (!url) throw new ContinenteUnavailableError('not_found');
    if (this.client && this.url === url) return this.client;
    await this.close();
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: this.authFetch() });
    const client = new Client({ name: 'cesto-ha', version: this.o.clientVersion ?? CLIENT_VERSION });
    try { await client.connect(transport); } catch (e) { throw mapError(e); }
    this.client = client; this.url = url;
    return client;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    assertAllowedTool(name);
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connect();
        const res = await client.callTool({ name, arguments: args }).catch(e => { throw mapError(e); });
        const result = (res.structuredContent as { result?: ToolResult } | undefined)?.result;
        if (result) return result;
        return { status: res.isError ? 'error' : 'success', error: res.isError ? { code: 'invalid_data', message: 'missing structured result' } : undefined };
      } catch (error) {
        await this.close();
        const retry = error instanceof ContinenteUnavailableError && error.reason === 'unreachable' && !isMutating(name) && attempt === 0;
        if (!retry) throw error;
      }
    }
  }

  async close(): Promise<void> { const c = this.client; this.client = undefined; await c?.close().catch(() => undefined); }
}

function mapError(e: unknown): Error {
  if (e instanceof ContinenteUnavailableError) return e;
  if (e instanceof StreamableHTTPError && e.code === 401) return new ContinenteUnavailableError('unauthorized');
  if (e instanceof Error && /\b401\b|unauthori[sz]ed/i.test(e.message)) return new ContinenteUnavailableError('unauthorized');
  if (e instanceof TypeError || (e instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|abort|timeout/i.test(e.message))) return new ContinenteUnavailableError('unreachable');
  return e instanceof Error ? e : new Error(String(e));
}
