// produce.js — the one command that turns a flow + ContentPlan into a
// narration-synced reel. Pipeline:
//   1. gen      — build fixture + execution pipeline.json (existing generators)
//   2. record   — drive the app at speed 1, capturing per-node boundaries
//   3. synth    — TTS each ContentPlan line to audio (+ real durations)
//   4. compose  — per-beat speed + VO mix + burned subtitles -> final reel
//
// Usage: node scripts/produce.js <flow>     (e.g. macd)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFlow, getStrategy, semanticAnchors } from './lib/build-flow.js';
import { createVoice, login, estimate } from '../src/lib/tts.js';
import { composeReel, composeSimple, concatClips } from '../src/lib/compose.js';

// Load local API keys (.env) so auto-planning can see OPENROUTER/ANTHROPIC keys.
(function loadEnv() {
  const p = path.resolve(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// Saved ElevenLabs session (shared with `npm run vo`) — enables the high-quality
// signed-in voice; without it produce falls back to the offline SAPI voice.
const AUTH_FILE = path.join(ROOT, '.eleven-auth.json');

function parseArgs(argv) {
  const a = { flow: null, login: false, voice: 'Alex', headed: false, sapi: false, mute: false, noSfx: false, noGifs: false, chromePort: null, skipUntil: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--login') a.login = true;
    else if (arg === '--headed') a.headed = true;
    else if (arg === '--sapi') a.sapi = true;            // force the offline voice
    else if (arg === '--mute' || arg === '--no-voice' || arg === '--no-audio') a.mute = true; // skip the voice service
    else if (arg === '--no-sfx') a.noSfx = true;         // skip sound effects
    else if (arg === '--no-gifs') a.noGifs = true;       // skip emotion gif overlays
    else if (arg === '--chrome') a.chromePort = Number(process.env.CHROME_PORT) || 9222;   // attach to running Chrome (no login)
    else if (arg === '--chrome-port') a.chromePort = Number(argv[++i]) || 9222;
    else if (arg === '--skip-until') a.skipUntil = Number(argv[++i]) || null; // seed nodes 1..N, skip their adds/wires
    else if (/^--skip-until=/.test(arg)) a.skipUntil = Number(arg.slice(arg.indexOf('=') + 1)) || null;
    else if (arg === '--voice') a.voice = argv[++i];
    else if (!arg.startsWith('-') && !a.flow) a.flow = arg;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const flow = args.flow || 'macd';
const log = (m) => console.log(`\x1b[36m[produce]\x1b[0m ${m}`);

function node(scriptArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, scriptArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${scriptArgs.join(' ')} exited ${code}`))));
  });
}

async function main() {
  // One-time sign-in for the ElevenLabs voice (opens a headed window).
  if (args.login) { await login(AUTH_FILE); return; }

  const strat = getStrategy(flow);
  const outDir = path.resolve(ROOT, strat.outDir);
  const planPath = path.resolve(ROOT, `flows/${flow}/content-plan.json`);
  // Auto-plan a brand-new flow: derive StrategyFacts, then let the AI planner
  // write the ContentPlan. Needs ANTHROPIC_API_KEY; otherwise tell the user how
  // to author one. An existing ContentPlan is used as-is (never overwritten).
  if (!fs.existsSync(planPath)) {
    if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      throw new Error(`No ContentPlan at flows/${flow}/content-plan.json. Either author one, or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY and re-run to auto-generate it (npm run gen:facts ${flow} && npm run plan ${flow}).`);
    }
    log('no ContentPlan — auto-planning (facts → AI planner)…');
    await node(['scripts/gen-facts.js', flow]);
    await node(['scripts/plan.js', flow]);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  // 1 + 2: generate, then record at speed 1 (the compose stage does the pacing).
  log('generating build + pipeline…');
  await node(['scripts/gen.js', flow]);
  log('recording (speed 1)…');
  const recArgs = ['src/record.js', `flow=${flow}`];
  if (args.skipUntil) recArgs.push(`skip-until=${args.skipUntil}`);
  await node(recArgs, { OUTPUT_SPEED: '1' });

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  // Strategy flows now interleave build scenes with reveals:
  //   build-plots → chart-reveal-1 (indicators) → build-strategy → chart-reveal (trades) → backtest-overview
  // Pure plotting flows stay 2 scenes (build + chart-reveal). Compose iterates
  // these in declared order and dispatches per scene id (see step 4 below).
  const okScenes = manifest.scenes.filter((s) => s.status === 'ok');
  if (!okScenes.length) throw new Error('No successful scenes in manifest');
  const isReveal = (id) => id.startsWith('chart-reveal') || id === 'backtest-overview';
  const buildScenes = okScenes.filter((s) => !isReveal(s.id));
  if (!buildScenes.length) throw new Error('No successful build scene in manifest');

  // 2.5: emotion GIFs — generate (uses the lock, so it's fast/stable) then load
  // the manifest. Tolerant: a gif failure must not sink the whole reel.
  let gifs = [];
  if (!args.noGifs) {
    log('generating emotion gifs…');
    try { await node(['scripts/gen-gifs.js', flow]); } catch (e) { log(`gifs: ${e.message} (continuing)`); }
    const gifManifest = path.join(outDir, 'assets', 'gifs', 'gifs.json');
    if (fs.existsSync(gifManifest)) {
      const gm = JSON.parse(fs.readFileSync(gifManifest, 'utf8'));
      gifs = (gm.markers || []).map((m) => ({
        file: path.join(outDir, m.file), actionRef: m.actionRef, at: m.at,
        durationSec: m.durationSec, position: m.position, scale: m.scale,
      }));
    }
  }

  // 3: resolve each ContentPlan beat to a node + synth its line.
  const anchors = semanticAnchors(buildFlow(strat));
  const anchorOf = (id) => anchors.find((a) => a.semanticId === id);
  const voDir = path.join(outDir, 'vo');
  fs.mkdirSync(voDir, { recursive: true });

  const resolve = (seg) => {
    const a = anchorOf(seg.actionRef);
    if (!a) throw new Error(`actionRef "${seg.actionRef}" does not resolve against the anchor table`);
    return a;
  };

  const outroLine = plan.outro && plan.outro.voiceover ? plan.outro.voiceover : null;
  const voBeats = [];
  let outroVo = null;
  if (args.mute) {
    // Skip the voice service entirely — silent reel, but pace from the offline
    // duration estimate so timing + subtitles still come out right. Fast path
    // for iterating on the video/camera/subtitles without TTS or a browser.
    log('voiceover: skipped (--mute) — silent reel, pacing from estimated durations');
    for (const seg of plan.build.voiceoverSegments) {
      const a = resolve(seg);
      voBeats.push({ execId: a.execId, actionRef: seg.actionRef, label: a.label, line: seg.line, narrationMs: estimate(seg.line).durationMs, audioPath: null });
    }
    if (outroLine) outroVo = { line: outroLine, narrationMs: estimate(outroLine).durationMs, audioPath: null };
  } else {
    // Pick the voice engine once and reuse it (one ElevenLabs session for all
    // lines). `auto` uses ElevenLabs when signed in, else the offline SAPI voice.
    const voice = await createVoice({ provider: args.sapi ? 'local' : 'auto', authFile: AUTH_FILE, voice: args.voice, headless: !args.headed, chromePort: args.chromePort });
    log(`voiceover engine: ${voice.engine}${voice.engine === 'sapi' ? ' (offline — run "npm run produce ' + flow + ' --login" once for ElevenLabs)' : ''}`);
    try {
      for (const [i, seg] of plan.build.voiceoverSegments.entries()) {
        const a = resolve(seg);
        const audioPath = path.join(voDir, `line-${i}.wav`);
        const r = await voice.synth(seg.line, { audioPath });
        log(`  ${seg.actionRef} (#${a.execId}) — ${(r.durationMs / 1000).toFixed(1)}s [${r.engine}]`);
        voBeats.push({ execId: a.execId, actionRef: seg.actionRef, label: a.label, line: seg.line, narrationMs: r.durationMs, audioPath: r.audioPath });
      }
      if (outroLine) {
        const r = await voice.synth(outroLine, { audioPath: path.join(voDir, 'outro.wav') });
        log(`  outro (chart) — ${(r.durationMs / 1000).toFixed(1)}s [${r.engine}]`);
        outroVo = { line: outroLine, narrationMs: r.durationMs, audioPath: r.audioPath };
      }
    } finally {
      await voice.close();
    }
  }

  // 4: compose each scene in its declared order. The strategy reel is now
  //   build-plots → chart-reveal-1 → build-strategy → chart-reveal → backtest-overview
  // and a pure plotting flow stays as the 2-scene build + chart-reveal.
  // Build scenes use the per-beat composer with the VO beats whose execIds
  // match the scene's addBoundaries (plot-half lands on phase A, strategy-half
  // on phase B). The MAIN chart-reveal (id === 'chart-reveal') carries the
  // outro VO; intermediate `chart-reveal-N` reveals are silent. The
  // backtest-overview is a silent hold (BacktestPanel renders Overview by default).
  const soundsDir = args.noSfx ? null : path.join(ROOT, 'assets', 'sounds');
  const outPath = path.join(outDir, `${flow}-reel.mp4`);
  const tempClips = [];
  let totalSec = 0, totalSegments = 0, totalSfx = 0, totalGifs = 0;
  let anyVoiced = false;
  for (const s of okScenes) {
    const clipOut = path.join(outDir, `_${s.id}-${flow}.mp4`);
    if (s.id === 'backtest-overview') {
      log(`composing "${s.id}" (silent metrics hold)…`);
      const r = await composeSimple({
        sceneClip: s.clip, clipDurationSec: s.clipDurationSec, sfxCues: s.sfxCues || [], soundsDir,
        voLine: null, voAudioPath: null, narrationMs: 0,
        resolution: manifest.resolution, fps: manifest.fps, outPath: clipOut,
      });
      totalSec += r.durationMs / 1000;
    } else if (s.id.startsWith('chart-reveal')) {
      const carriesOutro = s.id === 'chart-reveal' && !!outroVo;
      log(`composing "${s.id}" (${carriesOutro ? 'outro VO' : 'silent pan'})…`);
      const r = await composeSimple({
        sceneClip: s.clip, clipDurationSec: s.clipDurationSec, sfxCues: s.sfxCues || [], soundsDir,
        voLine: carriesOutro ? outroVo.line : null,
        voAudioPath: carriesOutro ? outroVo.audioPath : null,
        narrationMs: carriesOutro ? outroVo.narrationMs : 0,
        resolution: manifest.resolution, fps: manifest.fps, outPath: clipOut,
      });
      totalSec += r.durationMs / 1000;
      if (carriesOutro) anyVoiced = true;
    } else {
      // Build scene — partition VO beats and gifs by which execIds THIS scene
      // recorded (each build scene only knows about its own addBoundaries).
      const boundaryIds = new Set((s.addBoundaries || []).map((b) => String(b.execId)));
      const sceneVoBeats = voBeats.filter((vb) => boundaryIds.has(String(vb.execId)));
      const sceneGifs = gifs.filter((g) => sceneVoBeats.some((vb) => vb.actionRef === g.actionRef));
      log(`composing "${s.id}" (${sceneVoBeats.length} VO beat${sceneVoBeats.length === 1 ? '' : 's'}, per-beat speed + VO + SFX + gif overlays + subtitles)…`);
      const r = await composeReel({
        sceneClip: s.clip, addBoundaries: s.addBoundaries, actionsEndSec: s.actionsEndSec,
        clipDurationSec: s.clipDurationSec, voBeats: sceneVoBeats, sfxCues: s.sfxCues || [],
        soundsDir, gifs: sceneGifs,
        resolution: manifest.resolution, fps: manifest.fps, outPath: clipOut,
      });
      totalSec += r.totalMs / 1000;
      totalSegments += r.segments; totalSfx += r.sfx; totalGifs += r.gifs;
      if (r.voiced) anyVoiced = true;
    }
    tempClips.push(clipOut);
  }
  // ── stitch everything together, then clean up the per-scene temp clips.
  if (tempClips.length === 1) {
    fs.renameSync(tempClips[0], outPath);
  } else {
    log(`joining ${tempClips.length} scenes → ${path.basename(outPath)}…`);
    await concatClips(tempClips, outPath);
    for (const p of tempClips) { try { fs.rmSync(p, { force: true }); } catch {} }
  }

  const revealIds = okScenes.filter((s) => isReveal(s.id)).map((s) => s.id);
  log(`\x1b[32mdone\x1b[0m — ${path.relative(ROOT, outPath)}  (${totalSec.toFixed(1)}s, ${okScenes.length} scenes: ${buildScenes.length} build + ${revealIds.length} reveal [${revealIds.join(', ')}], build segs: ${totalSegments}, voice: ${anyVoiced ? 'yes' : 'no'}, sfx: ${totalSfx}, gifs: ${totalGifs})`);
}

main().catch((err) => { console.error(`\x1b[31m[produce] ${err.message}\x1b[0m`); process.exit(1); });
