import { readFileSync, existsSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type VisionProvider = 'none';

export interface Config {
  testMode: boolean;
  logLevel: LogLevel;
  visionProvider: VisionProvider;
  language: string;
  dataDir: string;
  port: number;
  /** Source address of the Home Assistant ingress proxy; only it may call admin routes. */
  ingressAddress: string;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error'];

/** Load add-on options. Unknown or missing values fall back to safe defaults (test mode ON). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const optionsPath = env.OPTIONS_PATH ?? '/data/options.json';
  let raw: Record<string, unknown> = {};
  if (existsSync(optionsPath)) raw = JSON.parse(readFileSync(optionsPath, 'utf8')) as Record<string, unknown>;
  const logLevel = LOG_LEVELS.includes(raw.log_level as LogLevel) ? (raw.log_level as LogLevel) : 'info';
  return {
    // Safety: anything other than an explicit `false` keeps test mode on.
    testMode: raw.test_mode !== false,
    logLevel,
    visionProvider: 'none',
    language: typeof raw.language === 'string' && raw.language ? raw.language : 'pt-PT',
    dataDir: env.DATA_DIR ?? '/data',
    port: Number(env.PORT ?? 8099),
    ingressAddress: env.INGRESS_ADDRESS ?? '172.30.32.2',
  };
}
