// Generate per-scene voiceover audio for a flow by automating ElevenLabs and
// intercepting the audio it serves (see src/lib/elevenlabs.js).
//
//   npm run vo macd                 # flows/macd/voiceover.txt -> output/macd/scenes/<id>.vo.mp3
//   npm run vo macd --headed        # watch it / solve a captcha if the site asks
//   npm run vo macd --voice Rachel  # pick a different character
//   npm run vo macd --dry-run       # just print the line->scene->file mapping
//   npm run vo macd --lines path.txt --scene macd-strategy --skip-existing
//
// Lines source: a plain text file, ONE line per scene in scene order (blank
// lines ignored). Line N maps to scene N of flows/<flow>/pipeline.json. The
// Studio's Voiceover lane picks the files up automatically.

import fs from 'node:fs';
import path from 'node:path';
import { getStrategy, ROOT } from './lib/build-flow.js';
import { createVoice, login } from '../src/lib/tts.js';
import { log } from '../src/lib/log.js';

// Saved ElevenLabs session (cookies/storage) so headless runs are signed in —
// the anonymous generator is hCaptcha-gated. Created by `--login`. Gitignored.
const AUTH_FILE = path.join(ROOT, '.eleven-auth.json');

function parseArgs(argv) {
  const a = { flow: null, lines: null, voice: 'Alex', headed: false, dryRun: false, scene: null, skipExisting: false, doLogin: false, sapi: false, chromePort: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headed') a.headed = true;
    else if (arg === '--login') a.doLogin = true;
    else if (arg === '--sapi') a.sapi = true;            // force the offline voice
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--skip-existing') a.skipExisting = true;
    else if (arg === '--chrome') a.chromePort = Number(process.env.CHROME_PORT) || 9222;
    else if (arg === '--chrome-port') a.chromePort = Number(argv[++i]) || 9222;
    else if (arg === '--voice') a.voice = argv[++i];
    else if (arg === '--lines') a.lines = argv[++i];
    else if (arg === '--scene') a.scene = argv[++i];
    else if (!arg.startsWith('-') && !a.flow) a.flow = arg;
    else throw new Error(`Unknown/!misplaced argument: ${arg}`);
  }
  if (a.doLogin) return a; // login doesn't need a flow
  if (!a.flow) throw new Error('usage: npm run vo <flow> [--lines file] [--voice Alex] [--headed] [--dry-run] [--scene id] [--skip-existing]\n       npm run vo --login   (one-time sign-in; required — anonymous TTS is captcha-gated)');
  return a;
}

// One non-empty line per scene, in order.
function readLines(file) {
  if (!fs.existsSync(file)) throw new Error(`Lines file not found: ${path.relative(ROOT, file)} — create it with one line per scene, in order.`);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function sceneIds(pipelinePath) {
  if (!fs.existsSync(pipelinePath)) throw new Error(`Pipeline not found: ${path.relative(ROOT, pipelinePath)} — run "npm run gen ${path.basename(path.dirname(pipelinePath))}" first.`);
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
  return (pipeline.scenes || []).map((s) => s.id);
}

// Remove any prior <id>.vo.* so a format change doesn't leave a stale sibling.
function clearExisting(dir, sceneId) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${sceneId}.vo.`)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.doLogin) {
    await login(AUTH_FILE);
    return;
  }
  if (!fs.existsSync(AUTH_FILE) && !args.sapi) {
    log.warn('No saved ElevenLabs session — using the offline voice instead.');
    log.warn('Run "npm run vo --login" once to sign in for the higher-quality ElevenLabs voice.');
  }

  const strat = getStrategy(args.flow);
  const pipelinePath = path.resolve(ROOT, strat.pipelineOut);
  const outScenes = path.resolve(ROOT, strat.outDir, 'scenes');
  const linesFile = path.resolve(ROOT, args.lines || path.join('flows', args.flow, 'voiceover.txt'));

  const ids = sceneIds(pipelinePath);
  const lines = readLines(linesFile);

  if (lines.length !== ids.length) {
    log.warn(`Lines (${lines.length}) ≠ scenes (${ids.length}); pairing the first ${Math.min(lines.length, ids.length)} by order.`);
  }

  // Build the line→scene→file plan.
  let plan = ids.slice(0, Math.min(ids.length, lines.length)).map((id, i) => ({
    sceneId: id, line: lines[i], out: path.join(outScenes, `${id}.vo.mp3`),
  }));
  if (args.scene) plan = plan.filter((p) => p.sceneId === args.scene || p.sceneId.includes(args.scene));
  if (plan.length === 0) throw new Error(args.scene ? `No scene matched "${args.scene}"` : 'Nothing to generate (empty lines?).');

  log.info(`Flow "${args.flow}": ${plan.length} line(s) → ${path.relative(ROOT, outScenes)}/<id>.vo.* · voice ${args.voice}`);
  for (const p of plan) log.info(`  ${p.sceneId}  ⟵  "${p.line.slice(0, 60)}${p.line.length > 60 ? '…' : ''}"`);

  if (args.dryRun) { log.ok('dry-run — no audio generated'); return; }

  fs.mkdirSync(outScenes, { recursive: true });
  // One shared voice engine for every scene (one ElevenLabs session, reused).
  // `auto` = ElevenLabs when signed in, else the offline voice; `--sapi` forces offline.
  const voice = await createVoice({ provider: args.sapi ? 'local' : 'auto', authFile: AUTH_FILE, voice: args.voice, headless: !args.headed, chromePort: args.chromePort });
  log.info(`  voice engine: ${voice.engine}`);
  let ok = 0;
  try {
    for (const p of plan) {
      if (args.skipExisting && fs.readdirSync(outScenes).some((f) => f.startsWith(`${p.sceneId}.vo.`))) {
        log.info(`  ${p.sceneId}: exists — skipped`);
        ok++;
        continue;
      }
      log.step(`Synth "${p.sceneId}"`);
      try {
        // Clear stale siblings first so a format change can't leave a dangling
        // <id>.vo.* of the wrong extension next to the new one.
        clearExisting(outScenes, p.sceneId);
        const r = await voice.synth(p.line, { audioPath: p.out });
        // Timings sidecar (ElevenLabs alignment, else estimated word timings).
        const timings = r.alignment || r.wordTimings;
        if (timings) fs.writeFileSync(path.join(outScenes, `${p.sceneId}.vo.json`), JSON.stringify({ text: p.line, alignment: r.alignment || null, wordTimings: r.wordTimings || null }, null, 2));
        log.ok(`  ${path.relative(ROOT, r.audioPath || p.out)} (${(r.durationMs / 1000).toFixed(1)}s)${timings ? ' + timings' : ''}`);
        ok++;
      } catch (err) {
        log.error(`  ${p.sceneId} failed: ${err.message}`);
      }
    }
  } finally {
    await voice.close();
  }
  log.info(`Done — ${ok}/${plan.length} voiceover file(s).`);
  if (ok !== plan.length) process.exitCode = 1;
}

main().catch((err) => { log.error(err.stack || String(err)); process.exit(1); });
