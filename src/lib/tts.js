// TTS adapter — Layer 1.5. Turns a narration line into { durationMs, wordTimings,
// audioPath }. The compiler only needs DURATION to pace the visuals, so this
// ships with an OFFLINE estimator (no API key) that the pacing solver can use
// today; a real synth provider (ElevenLabs / OpenAI / Azure) drops in behind the
// same interface later, returning a real audioPath + word-accurate timings.
//
// Keep this provider-agnostic: the rest of the pipeline depends only on the
// shape returned here, never on which engine produced it.

const DEFAULT_WPM = 160;       // measured narration pace for short-form reels
const LEAD_IN_MS = 150;        // tiny breath before the first word lands
const TAIL_MS = 350;           // pad after the last word so lines don't clip
const MIN_LINE_MS = 700;       // even a 2-word line needs room to read

const wordsOf = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

// Estimate a line's spoken length from its word count at `wpm`, plus fixed
// lead-in/tail. Also returns evenly-spaced word timings — good enough to drive
// subtitle reveal until a real engine supplies exact ones.
export function estimate(text, { wpm = DEFAULT_WPM } = {}) {
  const words = wordsOf(text);
  const speakMs = (words.length / wpm) * 60_000;
  const durationMs = Math.max(MIN_LINE_MS, Math.round(LEAD_IN_MS + speakMs + TAIL_MS));
  const perWord = words.length ? speakMs / words.length : 0;
  const wordTimings = words.map((w, i) => ({
    word: w,
    startMs: Math.round(LEAD_IN_MS + i * perWord),
    endMs: Math.round(LEAD_IN_MS + (i + 1) * perWord),
  }));
  return { text, durationMs, wordTimings, audioPath: null, engine: 'offline-estimate' };
}

// The synth entry point. Produces a REAL audio file + duration.
//   • On Windows, uses the built-in SAPI voice (System.Speech) — fully offline,
//     no API key — so the first synced clip needs nothing installed.
//   • A cloud provider (ElevenLabs/OpenAI/Azure) drops in behind this same
//     signature later for higher-quality voices.
//   • If synthesis isn't available, falls back to the silent estimate so the
//     pipeline still runs (timing holds; there's just no audible voice).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { FFPROBE } from '../config.js';

function exec(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => resolve({ code: -1, out, err }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function probeMs(file) {
  const { code, out } = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const s = parseFloat(String(out).trim());
  return code === 0 && Number.isFinite(s) ? Math.round(s * 1000) : null;
}

// Windows SAPI -> WAV via a tiny PowerShell one-liner. `rate` is SAPI's -10..10
// speaking-rate scale (0 = normal). Returns true on success. When `voice` is
// set we attempt to match it against the installed SAPI voices (exact name OR
// case-insensitive substring), so e.g. "David" matches "Microsoft David
// Desktop". An unmatched name falls back to the system default voice and the
// installed-voices list is printed once so the caller can pick a real one.
async function sapiToWav(text, outPath, { rate = 1, voice = null } = {}) {
  const escaped = String(text).replace(/'/g, "''");
  const escVoice = voice ? String(voice).replace(/'/g, "''") : '';
  const select = voice
    ? `$want='${escVoice}'; $v=$s.GetInstalledVoices() | Where-Object { $_.Enabled } | Select-Object -ExpandProperty VoiceInfo; ` +
      `$pick=$v | Where-Object { $_.Name -ieq $want } | Select-Object -First 1; ` +
      `if (-not $pick) { $pick=$v | Where-Object { $_.Name -ilike "*$want*" } | Select-Object -First 1 } ` +
      `if ($pick) { $s.SelectVoice($pick.Name) } else { Write-Host "SAPI: voice '$want' not installed. Available:" ; $v | ForEach-Object { Write-Host ('  - ' + $_.Name) } }; `
    : '';
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    select,
    `$s.Rate = ${Math.round(rate)};`,
    `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}');`,
    `$s.Speak('${escaped}');`,
    '$s.Dispose();',
  ].join(' ');
  const { code, out } = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (out && /SAPI: voice/.test(out)) process.stdout.write(out); // surface the diagnostic
  return code === 0 && fs.existsSync(outPath);
}

export async function synth(text, opts = {}) {
  const { audioPath, voice } = opts;
  if (audioPath && process.platform === 'win32') {
    // SAPI emits WAV — normalise the extension so the file isn't mislabeled
    // (e.g. a caller-supplied .mp3 path) and return the real path. `voice` is
    // forwarded so SAPI can SelectVoice when an installed match exists.
    const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');
    const ok = await sapiToWav(text, wavPath, { ...opts, voice }).catch(() => false);
    if (ok) {
      const durationMs = (await probeMs(wavPath)) ?? estimate(text, opts).durationMs;
      return { text, durationMs, wordTimings: scaledWordTimings(text, durationMs), audioPath: wavPath, engine: 'sapi' };
    }
  }
  return estimate(text, opts); // silent fallback (no audioPath written)
}

// Re-time the estimator's even word spacing onto a real clip's measured length,
// so subtitles can still reveal per word until an engine gives exact timings.
function scaledWordTimings(text, durationMs) {
  const est = estimate(text);
  const scale = est.durationMs ? durationMs / est.durationMs : 1;
  return est.wordTimings.map((w) => ({ word: w.word, startMs: Math.round(w.startMs * scale), endMs: Math.round(w.endMs * scale) }));
}

// A VOICE is a reusable synthesizer with a lifecycle: pick the engine once, run
// many lines through it, then close. Lets the ElevenLabs browser session be
// opened ONCE and shared across every beat (opening it per line would be slow
// and rate-limited). Engine selection:
//   • provider 'elevenlabs' — drive elevenlabs.io via the saved login session.
//   • provider 'local'      — Windows SAPI (offline) / silent estimate.
//   • provider 'auto'       — ElevenLabs if a login file exists, else local.
export async function createVoice({ provider = 'auto', authFile = null, voice = 'Alex', headless = true, chromePort = null, verbose = false, keepOpen = false } = {}) {
  const haveAuth = authFile && fs.existsSync(authFile);
  // Attaching to a running Chrome wins everything else — no login, no captcha.
  const useEleven = provider === 'elevenlabs' || chromePort || (provider === 'auto' && haveAuth);

  if (useEleven) {
    const el = await import('./elevenlabs.js');
    let session = null;
    return {
      engine: chromePort ? 'elevenlabs (attached)' : 'elevenlabs',
      async synth(text, { audioPath } = {}) {
        if (!session) session = await el.openSession({ headless, voice, authFile, chromePort, verbose, keepOpen });
        const { buffer, ext, alignment } = await el.synthLine(session, text);
        const outPath = audioPath ? audioPath.replace(/\.[^.]+$/, `.${ext}`) : null;
        if (outPath) fs.writeFileSync(outPath, buffer);
        const durationMs = (outPath ? await probeMs(outPath) : null) ?? estimate(text).durationMs;
        return { text, durationMs, audioPath: outPath, alignment, wordTimings: scaledWordTimings(text, durationMs), engine: 'elevenlabs' };
      },
      async close() { if (session) await el.closeSession(session).catch(() => {}); },
    };
  }

  return {
    engine: process.platform === 'win32' ? 'sapi' : 'estimate',
    // Forward `voice` so SAPI can SelectVoice — without this the configured
    // voice was silently ignored and you'd always hear the system default.
    async synth(text, opts = {}) { return synth(text, { ...opts, voice }); },
    async close() {},
  };
}

// One-time interactive ElevenLabs sign-in (delegates to the engine's login).
export async function login(authFile) {
  const el = await import('./elevenlabs.js');
  return el.login(authFile);
}
