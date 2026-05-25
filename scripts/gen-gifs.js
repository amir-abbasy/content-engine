// Generate emotion GIF/sticker overlays for a flow from its content-plan.
// Markers are authored (by the LLM) in flows/<flow>/content-plan.json:
//
//   • per narration beat:   voiceoverSegments[i].gif   (string | object | array)
//   • standalone overlays:  build.gifs[]               (intro/outro reactions)
//
// Each marker -> GIPHY search -> SEEDED random pick from the top results ->
// download to output/<flow>/assets/gifs/<id>.<ext>, recording the choice in
// gifs.json so reruns are stable (use --reroll to repick). The Studio overlay
// lane + the export compositor consume that manifest.
//
//   npm run gif macd                  # generate every marker
//   npm run gif macd --reroll         # pick fresh gifs (ignore the lock)
//   npm run gif macd --format webp    # transparent webp instead of gif
//   npm run gif macd --no-sticker --headed --dry-run --scene macd-strategy --api

import fs from 'node:fs';
import path from 'node:path';
import { getStrategy, ROOT } from './lib/build-flow.js';
import { createRng } from '../src/lib/humanize.js';
import { createGifSource } from '../src/lib/giphy.js';
import { log } from '../src/lib/log.js';

const DEFAULT_DURATION_SEC = 2.0;
const DEFAULT_POSITION = 'top-right';
const TOP_K = 20; // pick from the top N results (relevance-ordered)

function parseArgs(argv) {
  const a = { flow: null, reroll: false, headed: false, dryRun: false, scene: null, format: 'gif', api: false, sticker: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reroll') a.reroll = true;
    else if (arg === '--headed') a.headed = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--api') a.api = true;
    else if (arg === '--no-sticker') a.sticker = false;
    else if (arg === '--format') a.format = argv[++i];
    else if (arg === '--scene') a.scene = argv[++i];
    else if (!arg.startsWith('-') && !a.flow) a.flow = arg;
    else throw new Error(`Unknown/misplaced argument: ${arg}`);
  }
  if (!a.flow) throw new Error('usage: npm run gif <flow> [--reroll] [--format gif|webp|mp4] [--no-sticker] [--api] [--headed] [--dry-run] [--scene id]');
  return a;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
// Stable string → uint32 (FNV-1a) for per-marker seeding.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// Normalize a segment's `gif` (string | object | array) into marker specs.
function specsFromGif(gif) {
  if (!gif) return [];
  const arr = Array.isArray(gif) ? gif : [gif];
  return arr.map((g) => (typeof g === 'string' ? { search: g } : g)).filter((g) => g && g.search);
}

// Collect every marker from the content-plan, attaching scene + timing.
function collectMarkers(plan, { sceneIds, sceneDur, defaultSticker }) {
  const segs = (plan.build && plan.build.voiceoverSegments) || [];
  const markers = [];
  const usedIds = new Set();
  const uid = (base) => { let id = base, n = 1; while (usedIds.has(id)) id = `${base}-${n++}`; usedIds.add(id); return id; };
  const firstScene = sceneIds[0];

  segs.forEach((seg, i) => {
    const specs = specsFromGif(seg.gif);
    specs.forEach((spec) => {
      const sceneId = spec.scene || firstScene;
      const at = spec.at != null ? spec.at : (segs.length ? (i / segs.length) * (sceneDur[sceneId] || 0) : 0);
      markers.push({
        id: uid(spec.id || seg.actionRef || `seg${i}`),
        sceneId, search: spec.search,
        sticker: spec.sticker != null ? spec.sticker : defaultSticker,
        at, durationSec: spec.durationSec || DEFAULT_DURATION_SEC,
        position: spec.position || DEFAULT_POSITION,
        scale: spec.scale || null,
        actionRef: seg.actionRef || null, emotion: seg.emotion || null,
      });
    });
  });

  for (const g of (plan.build && plan.build.gifs) || []) {
    if (!g || !g.search) continue;
    const sceneId = g.scene || firstScene;
    markers.push({
      id: uid(g.id || 'gif'),
      sceneId, search: g.search,
      sticker: g.sticker != null ? g.sticker : defaultSticker,
      at: g.at != null ? g.at : 0, durationSec: g.durationSec || DEFAULT_DURATION_SEC,
      position: g.position || DEFAULT_POSITION, scale: g.scale || null,
      actionRef: null, emotion: null, standalone: true,
    });
  }
  return markers;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const strat = getStrategy(args.flow);
  const planPath = path.resolve(ROOT, 'flows', args.flow, 'content-plan.json');
  const pipelinePath = path.resolve(ROOT, strat.pipelineOut);
  const outDir = path.resolve(ROOT, strat.outDir, 'assets', 'gifs');
  const manifestPath = path.join(outDir, 'gifs.json');

  if (!fs.existsSync(planPath)) throw new Error(`No content-plan: ${path.relative(ROOT, planPath)} (the LLM generates this).`);
  if (!fs.existsSync(pipelinePath)) throw new Error(`No pipeline: ${path.relative(ROOT, pipelinePath)} — run "npm run gen ${args.flow}" first.`);
  const plan = readJson(planPath);
  const pipeline = readJson(pipelinePath);
  const sceneIds = (pipeline.scenes || []).map((s) => s.id);
  const sceneDur = Object.fromEntries((pipeline.scenes || []).map((s) => [s.id, (s.durationSec || 0) + (s.holdAfterSec || 0)]));
  const seed = (pipeline.record && pipeline.record.humanize && pipeline.record.humanize.seed) || 1;

  let markers = collectMarkers(plan, { sceneIds, sceneDur, defaultSticker: args.sticker });
  if (args.scene) markers = markers.filter((m) => m.sceneId === args.scene || m.sceneId.includes(args.scene));
  if (markers.length === 0) { log.warn('No gif markers in the content-plan (add `gif` to a segment or a build.gifs[] entry).'); return; }

  log.info(`Flow "${args.flow}": ${markers.length} gif marker(s) → ${path.relative(ROOT, outDir)}/`);
  for (const m of markers) log.info(`  ${m.id}  @${m.at.toFixed(1)}s ${m.position} ${m.sticker ? '[sticker]' : '[gif]'}  ⟵ "${m.search}"`);
  if (args.dryRun) { log.ok('dry-run — nothing downloaded'); return; }

  // Existing lock (chosen ids) — reused unless --reroll or the search changed.
  const prev = fs.existsSync(manifestPath) ? readJson(manifestPath) : { markers: [] };
  const prevById = new Map((prev.markers || []).map((m) => [m.id, m]));

  fs.mkdirSync(outDir, { recursive: true });
  const src = createGifSource({ provider: args.api ? 'api' : 'auto', headless: !args.headed });
  const out = [];
  let ok = 0;
  try {
    for (const m of markers) {
      const lock = prevById.get(m.id);
      const reuse = !args.reroll && lock && lock.search === m.search && lock.sticker === m.sticker && lock.chosenGiphyId;
      try {
        let chosenId = reuse ? lock.chosenGiphyId : null;
        if (!chosenId) {
          const candidates = await src.search(m.search, { sticker: m.sticker, count: TOP_K });
          if (!candidates.length) throw new Error(`no results for "${m.search}"`);
          const rng = createRng((seed ^ hash32(m.id + '|' + m.search)) >>> 0);
          chosenId = candidates[Math.floor(rng() * candidates.length)].id;
        }
        // Clear stale siblings, then download the chosen asset.
        for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
          if (f.startsWith(`${m.id}.`) && f !== 'gifs.json') fs.rmSync(path.join(outDir, f), { force: true });
        }
        const file = path.join(outDir, `${m.id}.${args.format}`);
        const r = await src.download({ id: chosenId }, { format: args.format, outPath: file });
        out.push({ ...m, chosenGiphyId: chosenId, sourceUrl: r.sourceUrl, file: path.relative(path.resolve(ROOT, strat.outDir), file).split(path.sep).join('/'), ext: args.format, bytes: r.bytes });
        log.ok(`  ${m.id}: ${chosenId} (${(r.bytes / 1024).toFixed(0)} KB)${reuse ? ' [locked]' : ''}`);
        ok++;
      } catch (err) {
        log.error(`  ${m.id} failed: ${err.message}`);
        if (lock) out.push(lock); // keep prior entry on failure
      }
    }
  } finally {
    await src.close();
  }

  fs.writeFileSync(manifestPath, JSON.stringify({ flow: args.flow, generatedAt: new Date().toISOString(), markers: out }, null, 2));
  log.ok(`Manifest: ${path.relative(ROOT, manifestPath)}`);
  log.info(`Done — ${ok}/${markers.length} gif(s).`);
  if (ok !== markers.length) process.exitCode = 1;
}

main().catch((err) => { log.error(err.stack || String(err)); process.exit(1); });
