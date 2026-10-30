import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = openDatabase(join(config.dataDir, 'app.db'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const app = buildApp({ config, db, version });
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`[continente-mcp] API listening on ${config.port} (test_mode=${config.testMode})`);
