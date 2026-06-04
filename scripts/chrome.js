// chrome.js — launches a real Chrome with the remote-debugging port open, so
// our scripts can attach to it (via Playwright CDP) and reuse the SESSION you
// have in that window. Sign in to ElevenLabs once here and the captcha is gone
// for every future `npm run produce <flow> --chrome` (or `npm run vo <flow>
// --chrome`).
//
// A DEDICATED profile dir lives at ./.chrome-profile/ so this Chrome doesn't
// fight with your day-to-day Chrome over a locked profile. To use your main
// Chrome instead, close it first and set CHROME_USER_DATA_DIR=<your profile>.
//
//   npm run chrome                 # default port 9222, dedicated profile
//   CHROME_PORT=9333 npm run chrome
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.CHROME_PORT) || 9222;
const PROFILE = process.env.CHROME_USER_DATA_DIR || path.join(ROOT, '.chrome-profile');
fs.mkdirSync(PROFILE, { recursive: true });

// Common Chrome install paths on Windows + macOS + Linux, in priority order.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error(`[chrome] Could not find Chrome. Set CHROME_PATH=<path to chrome.exe>.`);
  console.error(`        Searched:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
  process.exit(1);
}

console.log(`[chrome] launching ${chrome}`);
console.log(`[chrome] debug port: ${PORT}   profile: ${path.relative(ROOT, PROFILE) || PROFILE}`);
console.log(`[chrome] 1) sign into ElevenLabs in the window that opens (do this once)`);
console.log(`[chrome] 2) leave the window open`);
console.log(`[chrome] 3) in another terminal: npm run produce <flow> --chrome`);

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://elevenlabs.io/',
], { stdio: 'inherit' });
child.on('exit', (code) => { console.log(`[chrome] exited (${code})`); process.exit(code || 0); });
