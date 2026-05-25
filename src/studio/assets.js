// Studio data layer — flow-centric.
//
// The content model is now "from a flow to a video": each strategy lives in
// flows/<name>/ with its own generated pipeline.json and records to a FIXED
// output/<name>/ (see README "From a flow to a video"). So the Studio's unit is
// a PROJECT = (pipeline file + output dir):
//
//   • flow project   flows/<name>/pipeline.json  ->  output/<name>/
//   • legacy run      root pipeline.json          ->  output/<name>-<timestamp>/
//
// pipeline.json is the source of truth for what was authored (every scene +
// track, with full detail); the manifest only tells us what got rendered (clip
// files, status). We therefore build the timeline from the PIPELINE and enrich
// it with the manifest when one exists — so a flow can be inspected on the
// timeline before it has ever been recorded. Audio/text lanes resolve to empty
// arrays until those generators land.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const OUTPUT_DIR = path.join(ROOT, 'output');
const FLOWS_DIR = path.join(ROOT, 'flows');
const ROOT_PIPELINE = path.join(ROOT, 'pipeline.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

function authoredDurationSec(scene) {
  if (!scene) return 0;
  return (scene.durationSec || 0) + (scene.holdAfterSec || 0);
}

// First <sceneId>.vo.<ext> in a scenes dir, preferring common audio formats.
const VO_EXTS = ['m4a', 'mp3', 'wav', 'ogg', 'aac', 'opus'];
function findVoiceover(scenesDir, sceneId) {
  for (const ext of VO_EXTS) {
    const p = path.join(scenesDir, `${sceneId}.vo.${ext}`);
    if (exists(p)) return p;
  }
  return null;
}

// ── Project resolution ───────────────────────────────────────────────────
// Given a project id, return where its pipeline + output live. A flow project
// (flows/<id>/pipeline.json present) wins; otherwise it's a legacy run dir
// under output/ driven by the root pipeline.json.
function resolveProject(id) {
  const flowPipeline = path.join(FLOWS_DIR, id, 'pipeline.json');
  if (exists(flowPipeline)) {
    return { id, kind: 'flow', pipelinePath: flowPipeline, outDir: path.join(OUTPUT_DIR, id), mediaKey: id };
  }
  return { id, kind: 'run', pipelinePath: ROOT_PIPELINE, outDir: path.join(OUTPUT_DIR, id), mediaKey: id };
}

// List every selectable project, flows first (alpha), then legacy runs (newest
// first). A run dir that matches a flow name is skipped (already the flow).
export function listProjects() {
  const projects = [];
  const flowNames = new Set();

  if (isDir(FLOWS_DIR)) {
    for (const name of fs.readdirSync(FLOWS_DIR)) {
      const pipelinePath = path.join(FLOWS_DIR, name, 'pipeline.json');
      if (!exists(pipelinePath)) continue;
      flowNames.add(name);
      let pipeline = {};
      try { pipeline = readJson(pipelinePath); } catch { /* ignore broken */ }
      const outDir = path.join(OUTPUT_DIR, name);
      projects.push({
        id: name,
        kind: 'flow',
        label: name,
        pipelineName: pipeline.name || name,
        sceneCount: Array.isArray(pipeline.scenes) ? pipeline.scenes.length : 0,
        hasVideo: exists(path.join(outDir, 'manifest.json')) || isDir(path.join(outDir, 'scenes')),
        mtimeMs: mtimeMs(pipelinePath),
      });
    }
  }

  const runs = [];
  if (isDir(OUTPUT_DIR)) {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      if (flowNames.has(name)) continue; // already represented as a flow
      const manifestPath = path.join(OUTPUT_DIR, name, 'manifest.json');
      if (!exists(manifestPath)) continue;
      let manifest = {};
      try { manifest = readJson(manifestPath); } catch { continue; }
      runs.push({
        id: name,
        kind: 'run',
        label: name,
        pipelineName: manifest.pipeline || name,
        sceneCount: Array.isArray(manifest.scenes) ? manifest.scenes.length : 0,
        hasVideo: true,
        mtimeMs: mtimeMs(manifestPath),
      });
    }
  }

  projects.sort((a, b) => a.label.localeCompare(b.label));
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return [...projects, ...runs];
}

export function loadPipelineRaw(pipelinePath = ROOT_PIPELINE) {
  if (!exists(pipelinePath)) return null;
  return readJson(pipelinePath);
}

// Raw pipeline JSON for a given project (the file the editor round-trips).
export function loadPipelineForProject(id) {
  return loadPipelineRaw(resolveProject(id).pipelinePath);
}

// Build the project model: scenes laid out on a global timeline, built from the
// PIPELINE and enriched with the manifest (clip paths, render status) when the
// flow has been recorded. Works with no manifest (planned-but-unrendered flow).
export function loadProject(id) {
  const proj = resolveProject(id);
  const pipeline = loadPipelineRaw(proj.pipelinePath);
  if (!pipeline) throw new Error(`No pipeline for project "${id}" (looked at ${path.relative(ROOT, proj.pipelinePath)})`);

  const manifestPath = path.join(proj.outDir, 'manifest.json');
  const manifest = exists(manifestPath) ? readJson(manifestPath) : null;
  const manifestById = new Map((manifest?.scenes || []).map((s) => [s.id, s]));

  const defaultTheme = (pipeline.record && pipeline.record.effects && pipeline.record.effects.theme) || 'gold-ripple';

  // Web path (served by /media) for a file inside this project's output dir.
  const mediaUrl = (abs) => {
    if (!abs || !exists(abs)) return null;
    const rel = path.relative(proj.outDir, abs);
    if (rel.startsWith('..')) return null;
    return `/media/${encodeURIComponent(proj.mediaKey)}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  };

  let cursorSec = 0;
  const scenes = (pipeline.scenes || []).map((scene) => {
    const ms = manifestById.get(scene.id);
    const durationSec = authoredDurationSec(scene);
    const startSec = cursorSec;
    cursorSec += durationSec;

    const clipAbs = path.join(proj.outDir, 'scenes', `${scene.id}.mp4`);
    const clipFromManifest = ms && ms.clip && exists(ms.clip) ? ms.clip : null;
    const clip = exists(clipAbs) ? clipAbs : clipFromManifest;
    // Voiceover audio (from `npm run vo`): accept whatever format ElevenLabs
    // served — first matching <id>.vo.<ext> wins.
    const audioAbs = findVoiceover(path.join(proj.outDir, 'scenes'), scene.id);

    let status;
    if (ms && ms.status) status = ms.status;
    else if (clip) status = 'ok';
    else status = 'not-recorded';

    return {
      id: scene.id,
      description: scene.description || '',
      status,
      error: (ms && ms.error) || null,
      clipUrl: mediaUrl(clip),
      audioUrl: mediaUrl(audioAbs),
      authoredDurationSec: durationSec,
      startSec,
      target: scene.target,
      tracks: extractTracks(scene, { defaultTheme }),
    };
  });

  const bgm = pipeline.audio && pipeline.audio.bgm;
  const bgmFile = bgm ? (typeof bgm === 'string' ? bgm : bgm.file) : null;
  const bgmAbs = bgmFile ? path.join(proj.outDir, 'project', path.basename(bgmFile)) : null;

  return {
    id,
    kind: proj.kind,
    pipelinePath: path.relative(ROOT, proj.pipelinePath).split(path.sep).join('/'),
    pipelineName: pipeline.name || (manifest && manifest.pipeline) || id,
    recorded: !!manifest,
    generatedAt: (manifest && manifest.generatedAt) || null,
    resolution: (manifest && manifest.resolution) || (pipeline.output && pipeline.output.resolution) || { width: 1080, height: 1920 },
    fps: (manifest && manifest.fps) || (pipeline.output && pipeline.output.fps) || 30,
    totalAuthoredSec: cursorSec,
    audio: { bgm: bgmAbs && exists(bgmAbs) ? mediaUrl(bgmAbs) : null },
    scenes,
  };
}

// Pull every known track off an authored scene into a flat, UI-friendly shape.
function extractTracks(scene, project) {
  const t = (scene && scene.tracks) || {};
  const list = (a) => (Array.isArray(a) ? a : []);
  return {
    setup:     list(scene && scene.setup),
    input:     list(t.input),
    camera:    list(t.camera),
    attention: list(t.attention),
    voiceover: scene && scene.voiceover
      ? [{ at: 0, durationSec: authoredDurationSec(scene), text: scene.voiceover.text || '', audio: scene.voiceover.audio || null }]
      : [],
    sfx:       list(t.sfx),
    titles:    list(t.titles),
    subtitles: list(t.subtitles),
    effects: {
      theme: typeof scene?.effects === 'string' ? scene.effects
        : (scene?.effects && scene.effects.theme) || project.defaultTheme || null,
      palette: (scene?.effects && typeof scene.effects === 'object') ? scene.effects.palette || null : null,
    },
  };
}

// Resolve a /media request to an absolute path, guarding against traversal
// outside output/. The first segment is the project's output-dir name.
export function resolveMedia(mediaKey, relParts) {
  const base = path.join(OUTPUT_DIR, mediaKey);
  const abs = path.normalize(path.join(base, ...relParts));
  const baseNorm = path.normalize(base);
  if (!abs.startsWith(baseNorm + path.sep) && abs !== baseNorm) return null;
  if (!exists(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

export { OUTPUT_DIR, FLOWS_DIR, ROOT_PIPELINE };
