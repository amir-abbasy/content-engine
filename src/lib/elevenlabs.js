// ElevenLabs voiceover engine — drives the AI Voice Generator on elevenlabs.io
// and CAPTURES THE AUDIO IT SERVES via network interception (not by recording
// speakers). Per line:
//
//   1. fill the demo textarea          [aria-label="Enter your text here, …"]
//   2. open the voice picker           [aria-label="Voice"] → [data-trigger="Select"]
//   3. choose the "Alex" character     (role=option, exact name)
//   4. click Play                      [aria-label="Play"]
//   5. capture the /v1/text-to-speech/ response the Play triggers and return
//      its audio bytes (the with-timestamps endpoint returns JSON with a
//      base64 `audio_base64` field; the plain /stream/ endpoint returns audio
//      bytes directly — both are handled).
//
// IMPORTANT — the ANONYMOUS generator is hCaptcha-gated: headless runs get HTTP
// 401 + a tts_generation_error. So a one-time SIGN-IN is required. `login()`
// opens a headed window, you log in, and we save the session to an auth file;
// openSession({ authFile }) reuses it headlessly thereafter. (The official
// ElevenLabs API with a key is the alternative — same backend, no browser.)

import fs from 'node:fs';
import playwright from 'playwright';
import { log } from './log.js';

const URL = 'https://elevenlabs.io/';

const SEL = {
  textarea: 'textarea[aria-label="Enter your text here, ElevenLabs AI Voice Generator will read it for you"]',
  voiceButton: '[aria-label="Voice"]',
  voiceList: '[data-trigger="Select"]',
  voiceSearch: '[data-trigger="Select"] input, [role="dialog"] input, input[placeholder*="Search" i]',
  play: '[aria-label="Play"]',
};

const TTS_URL = /\/v1\/text-to-speech\//i;
const AUDIO_TIMEOUT_MS = 60_000;

const extForContentType = (ct = '') => {
  ct = ct.toLowerCase();
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'm4a';
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('ogg') || ct.includes('webm')) return 'ogg';
  return 'mp3'; // ElevenLabs serves mp3 by default
};

// Decode a captured TTS response into raw audio bytes. The /with-timestamps/
// endpoint returns JSON { audio_base64, alignment }; /stream/ returns audio.
function decodeTtsBody(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) {
    const j = JSON.parse(buf.toString('utf8'));
    const b64 = j.audio_base64 || j.audio || (j.data && j.data.audio_base64);
    if (!b64) throw new Error('TTS JSON had no audio_base64 field');
    return { buffer: Buffer.from(b64, 'base64'), ext: 'mp3', alignment: j.alignment || j.normalized_alignment || null };
  }
  return { buffer: buf, ext: extForContentType(ct), alignment: null };
}

async function dismissConsent(page) {
  for (const name of [/accept all/i, /allow all/i, /^accept$/i, /agree/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 1500 }).catch(() => {}); break; }
  }
}

// One-time interactive sign-in: opens a headed browser, waits for you to log in,
// then saves the session (cookies + storage) to `authFile` for headless reuse.
export async function login(authFile, { timeoutMs = 240_000 } = {}) {
  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${URL}app/sign-in`, { waitUntil: 'domcontentloaded' }).catch(() => page.goto(URL));
  log.step('Sign in to ElevenLabs in the opened window…');
  log.info('  When you are logged in and back on the site, press ENTER here to save the session.');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.storageState({ path: authFile });
  log.ok(`Saved session → ${authFile}`);
  await browser.close();
}

// Launch one reusable session on the generator. Pass { authFile } to reuse a
// saved login (recommended — the anonymous endpoint is captcha-gated).
export async function openSession({ headless = true, voice = 'Alex', selectors = {}, authFile = null } = {}) {
  const sel = { ...SEL, ...selectors };
  const browser = await playwright.chromium.launch({ headless });
  const contextOpts = {};
  if (authFile && fs.existsSync(authFile)) { contextOpts.storageState = authFile; }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Capture every TTS response (or any audio response) with a timestamp.
  const ttsResponses = [];
  page.on('response', (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const isAudio = ct.startsWith('audio/') || resp.request().resourceType() === 'media';
      if (TTS_URL.test(url) || isAudio) {
        ttsResponses.push({ resp, ts: Date.now(), url, ct, status: resp.status() });
      }
    } catch { /* ignore */ }
  });

  log.step(`ElevenLabs: opening ${URL}${authFile && fs.existsSync(authFile) ? ' (signed in)' : ' (anonymous)'}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  await page.waitForSelector(sel.textarea, { state: 'visible', timeout: 30_000 });

  return { browser, context, page, sel, voice, ttsResponses, voicePicked: false };
}

// Pick the named voice character. Done once per session (voice persists).
async function pickVoice(session) {
  const { page, sel, voice } = session;
  await page.click(sel.voiceButton, { timeout: 8000 });
  await page.locator(sel.voiceList).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

  // Filter the (virtualized) list via its search box when present.
  const search = page.locator(sel.voiceSearch).first();
  if (await search.count().catch(() => 0)) {
    await search.fill(voice).catch(() => {});
    await page.waitForTimeout(500);
  }

  // The clickable element is the role=option, not the inner text node.
  let opt = page.getByRole('option', { name: voice, exact: true }).first();
  if (!(await opt.count().catch(() => 0))) {
    opt = page.locator('[role="option"]').filter({ has: page.getByText(voice, { exact: true }) }).first();
  }
  if (!(await opt.count().catch(() => 0))) throw new Error(`voice "${voice}" not found in the picker`);
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await opt.click({ timeout: 8000 }).catch(async () => { await opt.click({ timeout: 4000, force: true }); });
  await page.waitForTimeout(400);

  const label = (await page.locator(sel.voiceButton).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (!new RegExp(`\\b${voice}\\b`, 'i').test(label)) log.warn(`  voice picker shows "${label}" (wanted "${voice}")`);
  else log.info(`  voice: ${voice}`);
  session.voicePicked = true;
}

// Synthesize ONE line. Returns { buffer, ext, alignment }. Throws on captcha/401
// or if no TTS response is captured before the timeout.
export async function synthLine(session, text, { timeoutMs = AUDIO_TIMEOUT_MS } = {}) {
  const { page, sel } = session;

  await page.click(sel.textarea, { timeout: 8000 });
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.fill(sel.textarea, text).catch(async () => { await page.keyboard.type(text); });

  if (!session.voicePicked) await pickVoice(session);

  const sinceTs = Date.now();
  await page.click(sel.play, { timeout: 8000 });

  return await new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      const hit = session.ttsResponses.find((a) => a.ts >= sinceTs - 250 && TTS_URL.test(a.url));
      if (hit) {
        if (hit.status === 401 || hit.status === 403) {
          return reject(new Error(`ElevenLabs returned ${hit.status} — anonymous TTS is hCaptcha-gated. Run "npm run vo <flow> --login" once to sign in, then retry.`));
        }
        if (hit.status >= 200 && hit.status < 300) {
          try {
            const body = await hit.resp.body();
            const { buffer, ext, alignment } = decodeTtsBody(body, hit.ct);
            if (buffer && buffer.length > 800) return resolve({ buffer, ext, alignment });
          } catch (e) { /* body not ready yet — keep polling */ }
        }
      }
      if (Date.now() > deadline) {
        return reject(new Error('no usable TTS response captured (try --headed; site markup may have changed or a captcha appeared)'));
      }
      setTimeout(tick, 300);
    };
    tick();
  }).finally(async () => {
    await page.click(sel.play, { timeout: 2000 }).catch(() => {}); // stop playback
  });
}

export async function closeSession(session) {
  try { await session.context.close(); } catch {}
  try { await session.browser.close(); } catch {}
}
