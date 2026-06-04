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
import path from 'node:path';
import playwright from 'playwright';
import { log } from './log.js';
import { ROOT } from '../config.js';

// When verbose mode is on, every picker step writes a screenshot here so the
// user can SEE what the picker actually did (the picker click happens in a
// fraction of a second otherwise).
const DEBUG_DIR = path.join(ROOT, 'output', '_voice-debug');

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

// Best-effort dismissal of the "We value your privacy" cookie dialog, plus any
// generic accept/agree button. Tries getByRole + getByText so banners that use
// non-button elements still close. Called at page-open AND right before picker
// interactions in case the dialog appears late.
async function dismissConsent(page) {
  const labels = [/^accept all cookies$/i, /accept all/i, /allow all/i, /^accept$/i, /^agree$/i, /i agree/i];
  for (const name of labels) {
    let target = page.getByRole('button', { name }).first();
    if (!(await target.count().catch(() => 0))) target = page.getByText(name, { exact: false }).first();
    if (await target.count().catch(() => 0)) {
      const ok = await target.click({ timeout: 1500 }).then(() => true).catch(() => false);
      if (ok) { await page.waitForTimeout(300); return true; }
    }
  }
  return false;
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

// Launch one reusable session on the generator. Three ways to get past the
// captcha-gated anonymous endpoint, in order of preference:
//   • chromePort  — attach to your already-running Chrome via CDP (uses your
//                   real logged-in session; no extra login dance).
//   • authFile    — reuse a session saved by login() (headless after one-time).
//   • neither     — anonymous; will 401 on the TTS request.
export async function openSession({ headless = true, voice = 'Alex', selectors = {}, authFile = null, chromePort = null, verbose = false, keepOpen = false } = {}) {
  const sel = { ...SEL, ...selectors };
  let browser, context, attached = false;

  if (chromePort) {
    // 127.0.0.1 avoids the IPv6 (::1) resolution that fails on some Windows
    // setups even when Chrome's debug port is listening on IPv4 only.
    const endpoint = `http://127.0.0.1:${chromePort}`;
    try {
      browser = await playwright.chromium.connectOverCDP(endpoint);
    } catch (e) {
      throw new Error(`Could not attach to Chrome on ${endpoint} (${e.message}). Run "npm run chrome" to launch a Chrome with the debug port open, then sign in to ElevenLabs in that window.`);
    }
    // Re-use the existing default context so we inherit cookies (= the login).
    context = browser.contexts()[0] || (await browser.newContext());
    attached = true;
    log.step(`ElevenLabs: attached to your Chrome on port ${chromePort} (using your session)`);
  } else {
    browser = await playwright.chromium.launch({ headless });
    const contextOpts = {};
    if (authFile && fs.existsSync(authFile)) { contextOpts.storageState = authFile; }
    context = await browser.newContext(contextOpts);
    log.step(`ElevenLabs: opening ${URL}${authFile && fs.existsSync(authFile) ? ' (signed in)' : ' (anonymous — will hit captcha)'}`);
  }
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

  if (verbose) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    log.info(`  verbose: screenshots → ${path.relative(ROOT, DEBUG_DIR)}/`);
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);

  // Take a screenshot AS SOON AS the page settles, so the user always gets at
  // least one artifact — even if the textarea wait below fails (e.g. when a
  // signed-in session lands on the dashboard instead of the demo homepage).
  if (verbose) {
    const file = path.join(DEBUG_DIR, 'picker-00-page-loaded.png');
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    log.info(`  page loaded: ${page.url()} — screenshot → ${path.relative(ROOT, file)}`);
  }

  try {
    await page.waitForSelector(sel.textarea, { state: 'visible', timeout: 30_000 });
  } catch (e) {
    if (verbose) {
      const file = path.join(DEBUG_DIR, 'picker-00b-textarea-missing.png');
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      log.warn(`  textarea missing — full-page screenshot → ${path.relative(ROOT, file)}`);
    }
    const here = page.url();
    throw new Error(`The ElevenLabs demo textarea didn't appear at ${here}. This usually happens when your signed-in session redirected away from the homepage — open ${URL} manually in that Chrome window (the homepage demo must be visible) and try again. Original error: ${e.message}`);
  }

  return { browser, context, page, sel, voice, ttsResponses, voicePicked: false, attached, verbose, keepOpen };
}

// Pick the named voice character. Done once per session (voice persists).
// Defensive because the signed-in picker often differs from the anonymous one:
// virtualized list, custom-voices first, possibly tabs/sections. So we (1) skip
// if the trigger already shows the wanted voice, (2) search inside the popover,
// (3) try exact then partial match, (4) scroll the list to load virtualized
// options, (5) dump available names if still not found, (6) verify by reading
// the trigger label after the click and surface a LOUD warning on mismatch.
async function pickVoice(session) {
  const { page, sel, voice, verbose } = session;
  const wantedRe = new RegExp(`\\b${voice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

  // Visibility helpers (no-ops unless verbose). Screenshots + a small dwell
  // between steps so the user can SEE the picker move.
  const shot = async (name) => {
    if (!verbose) return;
    const file = path.join(DEBUG_DIR, `picker-${name}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    log.info(`    📸 ${path.relative(ROOT, file)}`);
  };
  const dwell = async (ms = 900) => { if (verbose) await page.waitForTimeout(ms); };

  const triggerLabel = async () =>
    (await page.locator(sel.voiceButton).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

  // 1) Already on the right voice? Skip.
  const before = await triggerLabel();
  log.info(`  picker: trigger currently shows "${before}", want "${voice}"`);
  if (wantedRe.test(before)) {
    log.info(`  voice: ${voice} (already selected)`);
    await shot('01-already-correct');
    session.voicePicked = true;
    return;
  }
  await shot('01-before');

  // 2) Open the popover. Dismiss any late-appearing cookie banner + scroll the
  //    voice button into view (a sticky top bar otherwise intercepts the click).
  if (await dismissConsent(page)) log.info('  picker: dismissed cookie banner');
  await page.locator(sel.voiceButton).first().scrollIntoViewIfNeeded().catch(() => {});
  log.info('  picker: opening voice list…');
  await page.click(sel.voiceButton, { timeout: 8000 });
  const list = page.locator(sel.voiceList).first();
  await list.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await dwell();
  await shot('02-picker-open');

  // 3) Filter via a search box that is INSIDE the popover (avoid stray inputs).
  const popoverSearch = list.locator('input, [role="searchbox"]').first();
  if (await popoverSearch.count().catch(() => 0)) {
    log.info(`  picker: typing "${voice}" into search…`);
    await popoverSearch.fill(voice).catch(() => {});
    await page.waitForTimeout(verbose ? 700 : 500);
    await shot('03-after-search');
  } else {
    log.info('  picker: no search box, will scroll the list if needed');
  }

  // 4) Try to locate the option: exact role=option, then text-ancestor, then
  //    prefix-match (handles "Alex - Conversational" / "Alex (Calm)" variants).
  const findOption = async () => {
    let o = page.getByRole('option', { name: voice, exact: true }).first();
    if (await o.count().catch(() => 0)) return o;
    o = list.locator('[role="option"]').filter({ has: page.getByText(voice, { exact: true }) }).first();
    if (await o.count().catch(() => 0)) return o;
    o = list.locator('[role="option"]', { hasText: new RegExp(`^\\s*${voice}\\b`, 'i') }).first();
    return (await o.count().catch(() => 0)) ? o : null;
  };

  let opt = await findOption();

  // 5) Scroll the virtualized list to discover more options if needed.
  if (!opt) {
    for (let i = 0; i < 14 && !opt; i++) {
      await list.evaluate((el) => {
        const scroller = el.querySelector('[data-rac][role="listbox"]') || el;
        scroller.scrollBy(0, 400);
      }).catch(async () => { await page.mouse.wheel(0, 400); });
      await page.waitForTimeout(220);
      opt = await findOption();
    }
  }

  if (!opt) {
    // 6) Diagnostic dump so the user can see what's actually in the picker.
    const names = await list.locator('[role="option"]').allInnerTexts().catch(() => []);
    const sample = [...new Set(names.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 12).join(' · ');
    await shot('04-not-found');
    if (!session.keepOpen) await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`voice "${voice}" not found in the picker (visible options: ${sample || '<none>'}). Try --show to inspect, or a different voice name.`);
  }
  log.info(`  picker: found option for "${voice}" — about to click`);
  await shot('04-option-found');

  // Capture what's CURRENTLY visible in the picker before we close it, so a
  // verification failure can report a useful "available voices" diagnostic.
  const visibleNames = [...new Set(
    (await list.locator('[role="option"]').allInnerTexts().catch(() => []))
      .map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean)
  )];

  await opt.scrollIntoViewIfNeeded().catch(() => {});
  await dwell();
  await opt.click({ timeout: 8000 }).catch(async () => { await opt.click({ timeout: 4000, force: true }); });
  await page.waitForTimeout(verbose ? 800 : 300);
  await shot('05-after-click');
  // Only close the popover if we're not leaving the page open for inspection
  // (with --show the user wants to see the post-click state).
  if (!session.keepOpen) await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // 7) Verify: the trigger button should now show the picked voice. A mismatch
  //    means the click landed on a wrong element / the popover didn't close —
  //    fail loud rather than silently synth with the wrong voice.
  const after = await triggerLabel();
  await shot('06-final-trigger');
  log.info(`  picker: trigger after click shows "${after}"`);
  if (!wantedRe.test(after)) {
    const sample = visibleNames.slice(0, 14).join(' · ');
    throw new Error(`VOICE NOT APPLIED — wanted "${voice}", picker still shows "${after}". Available options in your picker: ${sample || '<none>'}. Pick one of those (npm run test:voice "<name>" --chrome) or re-run with --show to inspect.`);
  } else {
    log.info(`  voice: ${voice}`);
  }
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
  // With --show (keepOpen), leave the tab open for inspection. When ATTACHED
  // to the user's Chrome, leave their context + browser alone either way;
  // otherwise tear the whole thing down.
  if (session.keepOpen && session.attached) {
    log.info(`  (left the tab open in your Chrome — close it manually when done)`);
    return;
  }
  try { await session.page.close(); } catch {}
  if (session.attached) return;
  try { await session.context.close(); } catch {}
  try { await session.browser.close(); } catch {}
}
