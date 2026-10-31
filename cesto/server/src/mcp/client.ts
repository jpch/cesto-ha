import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertAllowedTool, isMutating, type ToolResult } from './tools.js';

/** Low-level transport: sends one tool call to the MCP process. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface StdioOptions { command: string; args?: string[]; env?: Record<string, string>; maxRestarts?: number }

/**
 * Runs continentept-mcp as a supervised child process over stdio.
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
