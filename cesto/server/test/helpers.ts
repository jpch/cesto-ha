import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Config } from '../src/config.js';

export const testConfig = (over: Partial<Config> = {}): Config => ({
  testMode: true, remoteCart: false, logLevel: 'error', visionProvider: 'none', ai: { provider: 'none', apiKey: null, model: null }, language: 'pt-PT', connectors: ['continente'],
  dataDir: '/tmp', port: 0, ingressAddress: '127.0.0.1', ...over,
});

export function makeApp(over: Partial<Config> = {}) {
  const db = openDatabase(':memory:');
  return { db, app: buildApp({ config: testConfig(over), db, version: '0.1.0' }) };
}

/** Later injected requests come from the LAN (direct port), not from Home Assistant ingress. */
export function asLan<T extends { inject: unknown }>(app: T, ip = '192.0.2.20'): T {
  const inject = (app.inject as (o: object) => unknown).bind(app);
  (app as { inject: unknown }).inject = (o: object | string) => inject(typeof o === 'string' ? { url: o, remoteAddress: ip } : { remoteAddress: ip, ...o });
  return app;
}
