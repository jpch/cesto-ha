import { readFileSync, existsSync } from 'node:fs';
import { enabledConnectors, type ConnectorId } from './connectors/registry.js';
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
  /** Supermarket connectors enabled in the add-on options (decision 62). */
  connectors: ConnectorId[];
  dataDir: string;
  port: number;
  /** Source address of the Home Assistant ingress proxy; only it may call admin routes. */
  ingressAddress: string;
  /** This add-on's Supervisor slug (e.g. `0369824b_cesto`), used by the app to find its ingress URL; null outside HA. */
  addonSlug?: string | null;
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
    connectors: enabledConnectors(raw.connectors),
    language: typeof raw.language === 'string' && raw.language ? raw.language : 'pt-PT',
    dataDir: env.DATA_DIR ?? '/data',
    port: Number(env.PORT ?? 8099),
    ingressAddress: env.INGRESS_ADDRESS ?? '172.30.32.2',
    addonSlug: addonSlug(env),
  };
}

const SLUG = /^[a-z0-9]+_[a-z0-9_]+$/;

/**
 * The Supervisor names an add-on container's host `<repo>-<slug>` (underscores become dashes), e.g.
 * `0369824b-cesto` for slug `0369824b_cesto`. `ADDON_SLUG` overrides it (tests, local runs).
 */
export function addonSlug(env: NodeJS.ProcessEnv): string | null {
  if (env.ADDON_SLUG && SLUG.test(env.ADDON_SLUG)) return env.ADDON_SLUG;
  const host = env.HOSTNAME ?? '';
  const m = /^([a-z0-9]+)-([a-z0-9-]+)$/.exec(host);
  if (!m) return null;
  const slug = `${m[1]}_${m[2]!.replace(/-/g, '_')}`;
  return SLUG.test(slug) ? slug : null;
}
