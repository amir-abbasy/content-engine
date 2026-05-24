// `npm run studio` — boots the Studio: the Node API server (this process)
// plus the Vite dev server (child process) that serves the React UI and
// proxies /api + /media back here. Ctrl-C tears both down.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './server.js'; // starts the API on STUDIO_API_PORT (default 5181)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WEB_PORT = process.env.STUDIO_WEB_PORT || 5180;

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const vite = spawn(npx, ['vite', '--config', path.join('studio', 'vite.config.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

console.log(`[studio] UI → http://localhost:${WEB_PORT}`);

const shutdown = () => { try { vite.kill(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
vite.on('exit', (code) => { console.log(`[studio] vite exited (${code})`); process.exit(code || 0); });
