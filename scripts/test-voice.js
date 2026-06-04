// Voice-only smoke test — synth N lines in ONE session and write each to disk.
// Use it to verify the voice service (ElevenLabs via --chrome / --login, or
// offline SAPI) without running record/compose/produce. With --count > 1 it
// exercises the SAME loop produce.js uses, so it's the fastest way to verify
// "multiple synths in a row" before committing to a full reel build.
//
//   npm run test:voice --chrome                # 1 line, default voice (Alex)
//   npm run test:voice Bria --chrome           # positional character name
//   npm run test:voice --chrome --count=2      # TWO lines in same session
//   npm run test:voice -- Adam --text "Hello." # custom text too
//   npm run test:voice Bria --chrome --show    # screenshot each picker step,
//                                              # leave the tab open
//   npm run test:voice --login                 # one-time sign-in flow
//   npm run test:voice --sapi                  # offline Windows voice
//
// Writes output/_voice-test-<voice>.<ext> for count=1, or
// output/_voice-test-<voice>-NN.<ext> for count>1, and prints engine + duration
// + size + MD5 (so you can see at a glance whether the lines are different).
// With --show, also writes output/_voice-debug/picker-NN-*.png at each step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createVoice, login } from '../src/lib/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(ROOT, '.eleven-auth.json');

const DEFAULT_LINES = [
  'First line: this is the very first synth of the session.',
  'Second line: a totally different sentence, used to verify the loop works.',
  'Third line: just one more, to make sure we are not flaky.',
  'Fourth line: this line proves the session can keep going indefinitely.',
];

function parseArgs(argv) {
  const a = { text: null, voice: 'Alex', headed: false, sapi: false, doLogin: false, chromePort: null, out: null, show: false, count: 1 };
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
    else if (/^--voice=/.test(arg)) a.voice = arg.slice(arg.indexOf('=') + 1);
    else if (arg === '--text') a.text = argv[++i];
    else if (arg === '--out') a.out = argv[++i];
    else if (arg === '--count') a.count = Math.max(1, Number(argv[++i]) || 1);
    else if (/^--count=/.test(arg)) a.count = Math.max(1, Number(arg.slice(arg.indexOf('=') + 1)) || 1);
    else if (!arg.startsWith('-') && positional++ === 0) a.voice = arg; // 1st positional = character name
    else throw new Error(`Unknown argument: ${arg}`);
  }
  // npm strips --flags from argv; read from npm_config_* as a fallback.
  const env = process.env;
  const isBool = (v) => v === 'true' || v === 'false' || v === '';
  if (env.npm_config_voice && !isBool(env.npm_config_voice)) a.voice = env.npm_config_voice;
  if (env.npm_config_text && !isBool(env.npm_config_text)) a.text = env.npm_config_text;
  if (env.npm_config_count && !isBool(env.npm_config_count)) a.count = Math.max(1, Number(env.npm_config_count) || 1);
  if (env.npm_config_chrome === 'true' || env.npm_config_chrome === '') a.chromePort = a.chromePort || (Number(env.CHROME_PORT) || 9222);
  if (env.npm_config_show === 'true') a.show = true;
  if (env.npm_config_sapi === 'true') a.sapi = true;
  if (env.npm_config_headed === 'true') a.headed = true;
  if (env.npm_config_login === 'true') a.doLogin = true;
  return a;
}

const args = parseArgs(process.argv.slice(2));

if (args.doLogin) {
  await login(AUTH_FILE);
  process.exit(0);
}

// Build the list of lines to synth (custom --text overrides defaults; --count
// picks the first N of the default lines so each synth has different bytes).
const lines = args.text
  ? Array.from({ length: args.count }, (_, i) => args.count > 1 ? `${args.text} (line ${i + 1})` : args.text)
  : DEFAULT_LINES.slice(0, args.count);

// Per-character output so you can A/B different voices without overwriting.
const safeName = String(args.voice).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice';

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
console.log(`count:   ${lines.length}`);

const results = [];
try {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const outName = args.out
      ? args.out
      : (lines.length > 1 ? `output/_voice-test-${safeName}-${String(i + 1).padStart(2, '0')}.wav` : `output/_voice-test-${safeName}.wav`);
    const outPath = path.resolve(ROOT, outName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    console.log(`\n[${i + 1}/${lines.length}] "${text}"`);
    const r = await voice.synth(text, { audioPath: outPath });
    const finalPath = r.audioPath || outPath;
    const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0;
    const md5 = fs.existsSync(finalPath)
      ? crypto.createHash('md5').update(fs.readFileSync(finalPath)).digest('hex').slice(0, 10)
      : '------';
    console.log(`  ${(r.durationMs / 1000).toFixed(2)}s audio · ${(size / 1024).toFixed(0)} KB · md5:${md5} · ${path.relative(ROOT, finalPath)}`);
    results.push({ idx: i + 1, path: finalPath, size, md5 });
  }
} finally {
  await voice.close();
}

// Summary — if any two MD5s match, every "line N" wrote the SAME audio
// (the loop bug). Fail loudly so the user sees it without inspecting files.
const md5s = results.map((r) => r.md5).filter((m) => m !== '------');
const allDistinct = new Set(md5s).size === md5s.length;
console.log(`\n\x1b[32m✓ done\x1b[0m in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${results.length} synth${results.length === 1 ? '' : 'es'}, all ${allDistinct ? '\x1b[32mDISTINCT\x1b[0m' : '\x1b[31mNOT DISTINCT (loop bug!)\x1b[0m'}.`);
if (results.length > 1 && !allDistinct) {
  console.error('  Some files share an MD5 — the second/later synth captured the same audio as an earlier one. The loop fix is not working.');
  process.exit(2);
}
