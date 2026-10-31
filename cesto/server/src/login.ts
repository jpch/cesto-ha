import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type LoginState = 'idle' | 'starting' | 'waiting_user' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export interface Command { command: string; args: string[] }
export interface LoginOptions {
  /** Virtual display with a built-in VNC server (Xvnc). */
  display: Command;
  /** websockify serving noVNC and bridging WebSocket to VNC. */
  websockify: Command;
  /** `continentept-mcp login --show-browser`. */
  login: Command;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Delay between starting the display and starting the browser. */
  displayDelayMs?: number;
}

/**
 * On-demand sign-in session: starts a virtual display, noVNC and a visible sign-in browser so the
 * user can tick "Não sou um robô" through the add-on page. Everything stops when it ends.
 * Emits `success` once the session was saved.
 */
export class LoginService extends EventEmitter {
  state: LoginState = 'idle';
  startedAt: string | null = null;
  private procs: ChildProcess[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: LoginOptions) { super(); }

  get active(): boolean { return this.state === 'starting' || this.state === 'waiting_user'; }

  start(): LoginState {
    if (this.active) return this.state;
    this.state = 'starting';
    this.startedAt = new Date().toISOString();
    const env = { ...(process.env as Record<string, string>), ...this.options.env };
    const run = (c: Command) => {
      const p = spawn(c.command, c.args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
      p.on('error', () => { if (this.active) this.finish('failed'); });
      this.procs.push(p);
      return p;
    };
    run(this.options.display).on('exit', () => { if (this.active) this.finish('failed'); });
    run(this.options.websockify);
    setTimeout(() => {
      if (!this.active) return;
      const login = run(this.options.login);
      this.state = 'waiting_user';
      login.on('exit', code => { if (this.active) this.finish(code === 0 ? 'succeeded' : 'failed'); });
    }, this.options.displayDelayMs ?? 1000);
    this.timer = setTimeout(() => { if (this.active) this.finish('timed_out'); }, this.options.timeoutMs ?? 6 * 60_000);
    return this.state;
  }

  cancel(): void { if (this.active) this.finish('cancelled'); }

  private finish(state: LoginState): void {
    this.state = state;
    clearTimeout(this.timer);
    for (const p of this.procs.splice(0)) if (p.exitCode === null) p.kill('SIGTERM');
    if (state === 'succeeded') this.emit('success');
  }
}
