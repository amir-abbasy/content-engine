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

// Decode a captured TTS response into raw audio bytes. ElevenLabs returns
// audio in any of three shapes, all of which we handle:
//   1. Raw audio bytes (content-type: audio/mpeg) — /stream/anonymous
//   2. Single JSON object { audio_base64, alignment } — /with-timestamps/
//   3. NDJSON stream — one JSON object per line, each with a slice of
//      audio_base64 — /stream/with-timestamps/anonymous (the one the demo
//      page actually uses). We concatenate all the chunks.
function decodeTtsBody(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (!ct.includes('json')) {
    return { buffer: buf, ext: extForContentType(ct), alignment: null };
  }
  const text = buf.toString('utf8').trim();
  // Shape (2): try as a single JSON object first.
  try {
    const j = JSON.parse(text);
    const b64 = j.audio_base64 || j.audio || (j.data && j.data.audio_base64);
    if (b64) return { buffer: Buffer.from(b64, 'base64'), ext: 'mp3', alignment: j.alignment || j.normalized_alignment || null };
  } catch { /* probably NDJSON — try that next */ }
  // Shape (3): NDJSON stream — split on newlines, concatenate every audio_base64.
  const chunks = [];
  let alignment = null;
  let lines = 0, parsed = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    lines++;
    try {
      const j = JSON.parse(t);
      parsed++;
      const b64 = j.audio_base64 || j.audio || (j.data && j.data.audio_base64);
      if (b64) chunks.push(Buffer.from(b64, 'base64'));
      const al = j.alignment || j.normalized_alignment;
      if (al && !alignment) alignment = al;
    } catch { /* skip malformed line */ }
  }
  if (chunks.length) {
    return { buffer: Buffer.concat(chunks), ext: 'mp3', alignment };
  }
  // Nothing worked — surface enough detail to debug.
  const preview = text.slice(0, 200).replace(/\s+/g, ' ');
  throw new Error(`TTS JSON decode failed: parsed ${parsed}/${lines} lines, no audio_base64 found. First 200 chars: ${preview}`);
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
export async function openSession({ headless = true, voice = 'Alex', selectors = {}, authFile = null, chromePort = null, chromeHeadless = false, verbose = false, keepOpen = false } = {}) {
  const sel = { ...SEL, ...selectors };
  let browser, context, attached = false;

  if (chromePort) {
    // 127.0.0.1 avoids the IPv6 (::1) resolution that fails on some Windows
    // setups even when Chrome's debug port is listening on IPv4 only.
    const endpoint = `http://127.0.0.1:${chromePort}`;
    const tryConnect = async () => playwright.chromium.connectOverCDP(endpoint);
    try {
      browser = await tryConnect();
    } catch (e) {
      // Auto-launch the helper Chrome (detached, so it outlives this process)
      // and retry the attach. Removes the two-terminal dance — first run opens
      // a Chrome window; you sign into ElevenLabs once and it stays.
      const { launchChromeDetached, waitForPort, profileExists } = await import('./chrome.js');
      // Headless reuse needs an already-signed-in profile. If the dedicated
      // profile is fresh, force a HEADED launch so the user can sign in — a
      // headless window could never show the login form or a captcha.
      const signedInBefore = profileExists();
      const useHeadless = chromeHeadless && signedInBefore;
      if (chromeHeadless && !signedInBefore) {
        log.warn('  --chrome-headless requested but the debug profile is fresh — launching HEADED so you can sign into ElevenLabs once. Headless will work on the next run.');
      }
      log.warn(`  no Chrome on ${endpoint} — launching ${useHeadless ? 'a headless' : 'one'} for you (sign in once if needed)…`);
      try { launchChromeDetached({ port: chromePort, headless: useHeadless }); } catch (e2) {
        throw new Error(`Could not auto-launch Chrome: ${e2.message}. Set CHROME_PATH or run "npm run chrome" yourself.`);
      }
      if (!(await waitForPort(chromePort, 25_000))) {
        throw new Error(`Auto-launched Chrome but ${endpoint} never came up. The window may still need a moment — try again, or run "npm run chrome" manually.`);
      }
      try { browser = await tryConnect(); }
      catch (e3) { throw new Error(`Could not attach to Chrome on ${endpoint} after auto-launch (${e3.message}).`); }
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

  // Intercept fetch() inside the page so we can keep a copy of every TTS audio
  // response — bypassing the CDP-attach limitation that response.body() returns
  // empty when Chrome (not Playwright) owns the streaming body. Also keep the
  // createObjectURL hook as a backup for any non-fetch audio paths.
  //
  // The clone-then-consume dance is the key: we clone the Response BEFORE
  // returning it to the page, then asynchronously buffer the clone's bytes.
  // The original Response is untouched, so the page's own audio playback works
  // exactly as before; we just observe a parallel copy.
  await page.addInitScript(() => {
    try {
      const w = window;
      if (w.__elInstalled) return;
      w.__elInstalled = true;
      w.__elBlobs = [];    // createObjectURL records: { url, ts, size, type, audio }
      w.__elFetches = [];  // fetch records:           { url, ts, b64, type }
      // -- createObjectURL hook (kept as backup; harmless when not used) --
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (obj) {
        const url = origCreate(obj);
        try {
          const type = obj && obj.type ? String(obj.type) : '';
          const size = obj && typeof obj.size === 'number' ? obj.size : 0;
          const audio = /^audio\//i.test(type) || (typeof MediaSource !== 'undefined' && obj instanceof MediaSource);
          w.__elBlobs.push({ url, ts: Date.now(), size, type, audio });
          if (w.__elBlobs.length > 50) w.__elBlobs.shift();
        } catch {}
        return url;
      };
      // -- fetch hook: clone TTS responses and buffer them as base64 --
      const TTS = /\/v1\/text-to-speech\//i;
      const bytesToB64 = (bytes) => {
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        return btoa(s);
      };
      const origFetch = w.fetch.bind(w);
      w.fetch = function (input, init) {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const isTts = typeof url === 'string' && TTS.test(url);
        const p = origFetch(input, init);
        if (!isTts) return p;
        return p.then((resp) => {
          try {
            // Clone BEFORE returning to caller — once the page reads resp.body,
            // cloning is no longer possible.
            const clone = resp.clone();
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            clone.arrayBuffer().then((buf) => {
              try {
                const bytes = new Uint8Array(buf);
                if (bytes.byteLength < 200) return;
                w.__elFetches.push({ url, ts: Date.now(), b64: bytesToB64(bytes), type: ct, size: bytes.byteLength });
                if (w.__elFetches.length > 20) w.__elFetches.shift();
              } catch {}
            }).catch(() => {});
          } catch {}
          return resp;
        });
      };
    } catch {}
  });

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
// Public wrapper: run the picker under a hard watchdog so a headless hang turns
// into a screenshot + diagnostic instead of stalling the whole produce run.
async function pickVoice(session, { watchdogMs = 45_000 } = {}) {
  const { page } = session;
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      // Always dump artifacts here even if verbose was off — this is exactly
      // when the user needs to SEE what the headless picker was looking at.
      try {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        await page.screenshot({ path: path.join(DEBUG_DIR, 'picker-HANG.png'), fullPage: true }).catch(() => {});
      } catch {}
      const opts = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
      const sample = [...new Set(opts.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 12).join(' · ');
      reject(new Error(`voice picker timed out after ${Math.round(watchdogMs / 1000)}s (headless render likely differs). Page: ${page.url()}. Options seen: ${sample || '<none>'}. Screenshot → ${path.relative(ROOT, path.join(DEBUG_DIR, 'picker-HANG.png'))}. Try a headed run (drop --chrome-headless) to compare.`));
    }, watchdogMs);
  });
  try {
    return await Promise.race([pickVoiceInner(session), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

async function pickVoiceInner(session) {
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
  const listVisible = await list.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  await dwell();
  await shot('02-picker-open');
  if (!listVisible) {
    // The popover didn't render (common headless difference). Try once more —
    // some builds open the list on a second click / on focus — then give up
    // fast rather than letting downstream locator.evaluate() auto-wait 30s each.
    log.warn('  picker: voice list not visible after click — retrying once…');
    await page.click(sel.voiceButton, { timeout: 4000 }).catch(() => {});
    const ok = await list.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!ok) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: path.join(DEBUG_DIR, 'picker-NOLIST.png'), fullPage: true }).catch(() => {});
      throw new Error(`voice picker popover never opened (selector "${sel.voiceList}"). In headless the dropdown may render differently. Screenshot → ${path.relative(ROOT, path.join(DEBUG_DIR, 'picker-NOLIST.png'))}. Drop --chrome-headless for a headed run, or the picker selector needs updating.`);
    }
  }

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

  // 5) Scroll the virtualized list to discover more options if needed. Use a
  //    SHORT explicit timeout on evaluate so a vanished popover can't make each
  //    iteration auto-wait the 30s default (that was the multi-minute headless
  //    hang). Fall back to a wheel scroll over the list's center.
  if (!opt) {
    for (let i = 0; i < 14 && !opt; i++) {
      const scrolled = await list.evaluate((el) => {
        const scroller = el.querySelector('[data-rac][role="listbox"]') || el;
        scroller.scrollBy(0, 400);
        return true;
      }, undefined, { timeout: 1500 }).catch(() => false);
      if (!scrolled) {
        const box = await list.boundingBox().catch(() => null);
        if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 400); }
        else break; // list is gone — stop scrolling, fall through to diagnostic
      }
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

  // Two timestamps — one Node-side (for filtering session.ttsResponses, which
  // were stamped with Node's Date.now() inside page.on('response', ...)), and
  // one page-side (for the createObjectURL hook installed via addInitScript,
  // which stamps blobs with the page's Date.now()). Same machine, same wall
  // clock — but keeping them separate avoids any cross-process drift.
  const sinceTs = Date.now();
  const sinceTsPage = await page.evaluate(() => Date.now()).catch(() => sinceTs);
  if (session.verbose) {
    const file = path.join(DEBUG_DIR, 'picker-07-before-play.png');
    await page.screenshot({ path: file }).catch(() => {});
  }
  await page.click(sel.play, { timeout: 8000 });
  if (session.verbose) {
    await page.waitForTimeout(800);
    const file = path.join(DEBUG_DIR, 'picker-08-after-play.png');
    await page.screenshot({ path: file }).catch(() => {});
    log.info(`  Play clicked — waiting up to ${Math.round(timeoutMs / 1000)}s for /v1/text-to-speech/…`);
  }

  return await new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      const hit = session.ttsResponses.find((a) => a.ts >= sinceTs - 250 && TTS_URL.test(a.url));
      if (hit) {
        if (hit.status === 401 || hit.status === 403) {
          return reject(new Error(`ElevenLabs returned ${hit.status} — anonymous/unauthenticated TTS is captcha-gated. Sign into ElevenLabs in the Chrome window that opened (the dedicated profile is fresh), then retry.`));
        }
        if (hit.status >= 200 && hit.status < 300) {
          // Primary path (works in BOTH attach and direct-launch): the page's
          // fetch() was wrapped at session-open; it now buffers a clone of
          // every TTS response. ElevenLabs streams audio through MediaSource /
          // Web Audio rather than via blob: URLs, so this is the only reliable
          // way to recover the bytes when Chrome owns the response.
          const captured = await page.evaluate((since) => {
            const recent = (window.__elFetches || []).filter((f) => f.ts >= since - 500).sort((a, b) => b.ts - a.ts);
            return recent[0] || null;
          }, sinceTsPage).catch(() => null);
          if (captured && captured.b64) {
            const buf = Buffer.from(captured.b64, 'base64');
            try {
              const { buffer, ext, alignment } = decodeTtsBody(buf, captured.type || hit.ct);
              if (buffer && buffer.length > 800) return resolve({ buffer, ext, alignment });
              if (session.verbose) log.warn(`  decoded but result too small (${buffer ? buffer.length : 'no'} bytes) — falling back to other paths`);
            } catch (e) {
              // Surface the decode error so we don't silently fall through to
              // a 60s timeout. The diagnostic in the timeout error will still
              // fire if the fallbacks also fail.
              session._lastDecodeErr = e.message;
              if (session.verbose) log.warn(`  fetch-capture decode failed: ${e.message}`);
            }
          }
          // Backup #1: pull from a blob the page just created. Some sites
          // (not ElevenLabs at time of writing, but other TTS providers using
          // this engine) do create real audio Blobs. Costs nothing to try.
          const blob = await page.evaluate(async (since) => {
            const all = (window.__elBlobs || []).filter((b) => b.ts >= since - 250);
            const candidates = [
              ...all.filter((b) => b.audio).sort((a, b) => b.ts - a.ts),
              ...all.filter((b) => !b.audio).sort((a, b) => b.ts - a.ts),
            ];
            for (const c of candidates) {
              try {
                const r = await fetch(c.url);
                if (!r.ok) continue;
                const ab = await r.arrayBuffer();
                if (ab.byteLength < 800) continue;
                const ct = r.headers.get('content-type') || c.type || 'audio/mpeg';
                if (!/^audio\//i.test(ct) && !c.audio) continue;
                const bytes = new Uint8Array(ab);
                let s = '';
                for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                return { b64: btoa(s), type: ct };
              } catch { /* try next */ }
            }
            return null;
          }, sinceTsPage).catch(() => null);
          if (blob) {
            const buffer = Buffer.from(blob.b64, 'base64');
            if (buffer.length > 800) return resolve({ buffer, ext: extForContentType(blob.type), alignment: null });
          }
          // Backup #2 (works on direct-launch where Playwright owns the response).
          try {
            const body = await hit.resp.body();
            const { buffer, ext, alignment } = decodeTtsBody(body, hit.ct);
            if (buffer && buffer.length > 800) return resolve({ buffer, ext, alignment });
          } catch (e) { /* body not ready yet — keep polling */ }
        }
      }
      if (Date.now() > deadline) {
        // Diagnostic dump on timeout: screenshot + everything we saw on the
        // wire after Play, so the user can tell whether they're sitting on a
        // captcha, a not-signed-in landing, or a stalled request.
        if (session.verbose) {
          const file = path.join(DEBUG_DIR, 'picker-09-timeout.png');
          await page.screenshot({ path: file, fullPage: true }).catch(() => {});
        }
        const since = session.ttsResponses.filter((a) => a.ts >= sinceTs - 250);
        const seen = since.length
          ? since.slice(-8).map((a) => `${a.status} ${a.url.split('?')[0]}`).join(' | ')
          : '<no TTS-like responses captured>';
        const captcha = await page.locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]').count().catch(() => 0);
        // Dump what the in-page hooks saw — tells us whether (a) hooks ran,
        // (b) anything was captured since Play, (c) what their types/sizes
        // look like. Critical for diagnosing why extraction failed when the
        // server clearly returned audio.
        const dump = await page.evaluate((since) => {
          const out = {};
          if (!window.__elInstalled) return { installed: false };
          out.installed = true;
          const blobs = (window.__elBlobs || []).filter((b) => b.ts >= since - 250);
          out.blobs = blobs.length ? blobs.map((b) => `${b.type || '?'} ${b.size}B`).join(' · ') : '<none>';
          const fets = (window.__elFetches || []).filter((f) => f.ts >= since - 500);
          out.fets = fets.length ? fets.map((f) => `${f.type || '?'} ${f.size}B`).join(' · ') : '<none>';
          out.allFets = (window.__elFetches || []).length;
          return out;
        }, sinceTsPage).catch((e) => ({ error: e.message }));
        const blobsDump = dump.installed === false
          ? '<hooks not installed — init script may not have run>'
          : dump.error
            ? `<page.evaluate failed: ${dump.error}>`
            : `blobs=${dump.blobs}, fetches=${dump.fets} (${dump.allFets} total TTS fetches captured)`;
        const url = page.url();
        return reject(new Error(
          `no usable TTS response after Play (${Math.round(timeoutMs / 1000)}s). ` +
          `Page: ${url}. ` +
          (captcha ? `A captcha frame is visible — solve it in the open Chrome window and retry. ` : '') +
          `If the auto-launched Chrome (.chrome-profile/) is FRESH, sign into ElevenLabs in that window once and retry. ` +
          `Last responses since Play: ${seen}. ` +
          `Page captures since Play: ${blobsDump}.` +
          (session._lastDecodeErr ? ` Decode error: ${session._lastDecodeErr}.` : '')
        ));
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
