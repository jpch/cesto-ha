import { readFileSync, existsSync } from 'node:fs';
import { AI_PROVIDERS, type AiConfig, type AiProviderName } from './ai.js';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type VisionProvider = 'none';

export interface Config {
  testMode: boolean;
  logLevel: LogLevel;
  visionProvider: VisionProvider;
  /** Optional AI provider shared by promotion suggestions and the planned vision AI. Default none. */
  ai: AiConfig;
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
    ai: {
      provider: AI_PROVIDERS.includes(raw.ai_provider as AiProviderName) ? (raw.ai_provider as AiProviderName) : 'none',
      apiKey: typeof raw.ai_api_key === 'string' && raw.ai_api_key.trim() ? raw.ai_api_key.trim() : null,
      model: typeof raw.ai_model === 'string' && raw.ai_model.trim() ? raw.ai_model.trim() : null,
    },
    language: typeof raw.language === 'string' && raw.language ? raw.language : 'pt-PT',
    dataDir: env.DATA_DIR ?? '/data',
    port: Number(env.PORT ?? 8099),
    ingressAddress: env.INGRESS_ADDRESS ?? '172.30.32.2',
  };
}
