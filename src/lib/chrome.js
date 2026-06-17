// Chrome helper — finds the installed Chrome, launches it DETACHED with the
// remote-debugging port + a dedicated profile, and polls until the port is
// listening. Used by elevenlabs.js to auto-spin up the helper Chrome on first
// `--chrome` use, so the user doesn't need to keep a second terminal open with
// `npm run chrome`. Also reused by scripts/chrome.js for the explicit case.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../config.js';

const DEFAULT_PROFILE = path.join(ROOT, '.chrome-profile');

// Where Chrome typically lives on the host. Honors CHROME_PATH first.
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Probe the DevTools endpoint. Returns true if the port answers HTTP.
export function isPortOpen(port = 9222, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Spawn Chrome detached so it OUTLIVES the parent (closing the terminal that
// triggered the launch won't take Chrome with it). Returns the child handle.
export function launchChromeDetached({ port = 9222, profile = DEFAULT_PROFILE, url = 'https://elevenlabs.io/', headless = false } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH=<path to chrome.exe>.');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Headless reuse: only safe AFTER the profile has been signed in once (in a
  // headed run) — the session cookies persist in the profile, so headless
  // Chrome inherits the login. A FRESH profile can't be signed into headlessly,
  // so the first --chrome run should stay headed.
  if (headless) args.push('--headless=new', '--disable-gpu', '--window-size=1280,900');
  args.push(url);
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref(); // let parent exit independently of Chrome
  return child;
}

// True only if the dedicated debug profile already has data (= it's been
// launched before, presumably to sign in). Used to warn on a headless first
// run that could never authenticate.
export function profileExists(profile = DEFAULT_PROFILE) {
  try { return fs.existsSync(path.join(profile, 'Default')) || fs.existsSync(path.join(profile, 'Local State')); }
  catch { return false; }
}

// Poll the debug port until it answers or `timeoutMs` elapses.
export async function waitForPort(port = 9222, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
