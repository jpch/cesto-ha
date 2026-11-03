// Container smoke test (2.0.0): the API server starts, /health answers in test mode, unauthenticated calls
// are refused, and without the Continente MCP add-on the link reports it unavailable. No supermarket call.
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';

const dataDir = mkdtempSync('/tmp/api-');
const server = spawn('node', ['dist/index.js'], { cwd: '/opt/server', stdio: 'inherit',
  env: { ...process.env, DATA_DIR: dataDir, OPTIONS_PATH: `${dataDir}/none.json`, PORT: '18099', SHARE_DIR: mkdtempSync('/tmp/share-') } });
let health;
for (let i = 0; i < 50 && !health; i++) {
  await new Promise(r => setTimeout(r, 200));
  health = await fetch('http://127.0.0.1:18099/api/v1/health').then(r => r.json()).catch(() => undefined);
}
const unauth = await fetch('http://127.0.0.1:18099/api/v1/me').then(r => r.status).catch(() => 0);
const which = await new Promise(r => spawn('sh', ['-c', 'command -v continentept-mcp Xvnc websockify'], { stdio: 'ignore' }).on('exit', c => r(c)));
server.kill();
console.log(JSON.stringify({ api_health: health ?? null, unauthenticated_status: unauth, bundled_mcp_absent: which !== 0 }));
if (!health || health.test_mode !== true || unauth !== 401 || health.continente?.available !== false || which === 0) process.exit(1);
process.exit(0);
