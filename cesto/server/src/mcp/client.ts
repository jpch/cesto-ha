import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertAllowedTool, isMutating, type ToolResult } from './tools.js';

/** Low-level transport: sends one tool call to the MCP process. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface StdioOptions { command: string; args?: string[]; env?: Record<string, string>; maxRestarts?: number }

/**
 * Runs an MCP server as a supervised child process over stdio. 2.0.0: development and tests only
 * (MCP_COMMAND); the add-on itself talks to the Continente MCP add-on through HttpMcpTransport.
 * If the process exits, the next call starts a new one (bounded by maxRestarts in a row).
 */
export class StdioMcpTransport implements McpTransport {
  private client?: Client;
  private connecting?: Promise<Client>;
  private failures = 0;
  private started = false;
  /** Number of times the MCP process was started again after the first start. */
  restarts = 0;

  constructor(private readonly options: StdioOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command, args: this.options.args ?? [],
        env: { ...(process.env as Record<string, string>), ...this.options.env }, stderr: 'inherit',
      });
      const client = new Client({ name: 'cesto-ha', version: '0.1.0' });
      transport.onclose = () => { if (this.client === client) this.client = undefined; };
      await client.connect(transport);
      if (this.started) this.restarts++;
      this.started = true;
      this.client = client;
      return client;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    assertAllowedTool(name);
    const max = this.options.maxRestarts ?? 3;
    for (;;) {
      try {
        const client = await this.connect();
        const res = await client.callTool({ name, arguments: args });
        this.failures = 0;
        const result = (res.structuredContent as { result?: ToolResult } | undefined)?.result;
        if (result) return result;
        return { status: res.isError ? 'error' : 'success', error: res.isError ? { code: 'invalid_data', message: 'missing structured result' } : undefined };
      } catch (error) {
        this.client = undefined;
        // Never retry a cart mutation: it may already have been sent.
        if (++this.failures > max || isMutating(name)) throw error;
      }
    }
  }

  async close(): Promise<void> { await this.client?.close(); this.client = undefined; }
}

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
    const client = new Client({ name: 'cesto-ha', version: '2.0.0' });
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
