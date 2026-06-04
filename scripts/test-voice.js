// Voice-only smoke test — synth ONE line and write it to disk. Use it to
// verify the voice service (ElevenLabs via --chrome / --login, or offline SAPI)
// without running record/compose/produce.
//
//   npm run test:voice --chrome                # default voice (Alex)
//   npm run test:voice Bria --chrome           # positional character name
//   npm run test:voice -- Adam --text "Hello." # custom text too
//   npm run test:voice Bria --chrome --show    # screenshot each picker step,
//                                              # leave the tab open
//   npm run test:voice --login                 # one-time sign-in flow
//   npm run test:voice --sapi                  # offline Windows voice
//
// Writes output/_voice-test-<voice>.<ext> and prints engine + duration + size.
// With --show, also writes output/_voice-debug/picker-NN-*.png at each step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoice, login } from '../src/lib/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(ROOT, '.eleven-auth.json');

const DEFAULT_TEXT = 'This is a voice-only smoke test of the content engine.';

function parseArgs(argv) {
  const a = { text: null, voice: 'Alex', headed: false, sapi: false, doLogin: false, chromePort: null, out: null, show: false };
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headed') a.headed = true;
    else if (arg === '--sapi') a.sapi = true;
    else if (arg === '--login') a.doLogin = true;
    else if (arg === '--show') a.show = true;      // verbose picker + screenshots + keep tab open
    else if (arg === '--chrome') a.chromePort = Number(process.env.CHROME_PORT) || 9222;
    else if (arg === '--chrome-port') a.chromePort = Number(argv[++i]) || 9222;
    else if (arg === '--voice') a.voice = argv[++i];
    else if (arg === '--text') a.text = argv[++i];
    else if (arg === '--out') a.out = argv[++i];
    else if (!arg.startsWith('-') && positional++ === 0) a.voice = arg; // 1st positional = character name
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.doLogin) {
  await login(AUTH_FILE);
  process.exit(0);
}

const text = args.text || DEFAULT_TEXT;
// Per-character output so you can A/B different voices without overwriting.
const safeName = String(args.voice).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice';
const outPath = path.resolve(ROOT, args.out || `output/_voice-test-${safeName}.wav`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// --show: clear stale screenshots so each run yields a clean numbered set.
if (args.show) {
  const dbg = path.join(ROOT, 'output', '_voice-debug');
  if (fs.existsSync(dbg)) for (const f of fs.readdirSync(dbg)) {
    if (/^picker-/.test(f)) fs.rmSync(path.join(dbg, f), { force: true });
  }
}

const t0 = Date.now();
const voice = await createVoice({
  provider: args.sapi ? 'local' : 'auto',
  authFile: AUTH_FILE, voice: args.voice, headless: !args.headed, chromePort: args.chromePort,
  verbose: args.show, keepOpen: args.show,
});
console.log(`engine:  ${voice.engine}`);
console.log(`voice:   ${args.voice}`);
console.log(`text:    "${text}"`);
console.log(`out:     ${path.relative(ROOT, outPath)}`);

try {
  const r = await voice.synth(text, { audioPath: outPath });
  const finalPath = r.audioPath || outPath;
  const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
  console.log(`\n\x1b[32m✓ done\x1b[0m in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${(r.durationMs / 1000).toFixed(2)}s of audio, ${(size / 1024).toFixed(0)} KB at ${path.relative(ROOT, finalPath)}`);
  if (!r.audioPath) console.log('  (no audio file written — provider returned an estimate only; check your --chrome / --login / --sapi flags)');
} finally {
  await voice.close();
}
