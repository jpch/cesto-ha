import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import type { Config } from '../src/config.js';

export const testConfig = (over: Partial<Config> = {}): Config => ({
  testMode: true, logLevel: 'error', visionProvider: 'none', language: 'pt-PT',
  dataDir: '/tmp', port: 0, ingressAddress: '127.0.0.1', ...over,
});

export function makeApp(over: Partial<Config> = {}) {
  const db = openDatabase(':memory:');
  return { db, app: buildApp({ config: testConfig(over), db, version: '0.1.0' }) };
}
