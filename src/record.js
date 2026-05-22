// Content Engine — recorder.
//
// Opens the target app once, waits for Pyodide, then walks the pipeline's
// scenes in a single continuous recording. Each scene is a TIMELINE of
// typed events on absolute scene-relative time axes — the scheduler in
// timeline.js dispatches them in order, the cursor driver in
// cursor-driver.js animates pointer motion organically, the humanizer in
// humanize.js shapes durations with a seeded RNG. Afterwards the raw
// session video is sliced + cropped per scene into vertical clips, with
// per-keyframe ease on the pan.
//
//   node src/record.js [pipeline.json] [--headed|--headless] [--out dir] [--url u]

import fs from 'node:fs';
import path from 'node:path';
import { parseCli } from './config.js';
import { loadPipeline } from './lib/pipeline.js';
import { launchRecorder, waitForPyodide } from './lib/browser.js';
import { runEvent } from './lib/actions.js';
import { runEvents } from './lib/timeline.js';
import { buildAutoCamera } from './lib/autocamera.js';
import { createRng } from './lib/humanize.js';
import { createCursorDriver } from './lib/cursor-driver.js';
import { resolveTarget } from './lib/target.js';
import { cropScene, ffprobeDuration } from './lib/crop.js';
import { log } from './lib/log.js';

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Camera/input point resolution must NEVER block the live timeline. A camera
// keyframe often anchors on a transient element (a context menu, a popover, a
// node) that may already be gone by the time a "hold" keyframe fires. With the
// default 30s timeout, each such miss stalls the whole scheduler — turning a
// 45s scene into minutes. Resolve with a short timeout: a miss returns null
// fast and the camera simply holds its previous position.
const CAMERA_RESOLVE_TIMEOUT_MS = 400;

// Resolve a camera event's keyframe coords (point or selector + optional position).
async function resolveCameraPoint(page, ev) {
  if (ev.point) return { cx: ev.point.x, cy: ev.point.y };
  if (!ev.selector) return null;
  const loc = page.locator(ev.selector).first();
  const box = await loc.boundingBox({ timeout: CAMERA_RESOLVE_TIMEOUT_MS }).catch(() => null);
  if (!box) return null;
  const pos = ev.position || { x: box.width / 2, y: box.height / 2 };
  return { cx: box.x + pos.x, cy: box.y + pos.y };
}

// Resolve the absolute coords for an input event's target — used by
// `cameraFollow` to drop a camera keyframe at the same spot the cursor is
// about to click.
async function resolveInputPoint(page, ev) {
  if (!ev.selector) return null;
  const loc = page.locator(ev.selector).first();
  const box = await loc.boundingBox({ timeout: CAMERA_RESOLVE_TIMEOUT_MS }).catch(() => null);
  if (!box) return null;
  const pos = ev.position || { x: box.width / 2, y: box.height / 2 };
  return { cx: box.x + pos.x, cy: box.y + pos.y };
}

async function recordSession(pipeline, { headless, rawDir }) {
  const { browser, context, page, recordingStartedAt } = await launchRecorder({ pipeline, rawDir, headless });
  const rng = createRng(pipeline.record.humanize?.seed ?? 1);
  const cursor = createCursorDriver(page, rng, pipeline.record.cursor || {});
  const ctx = { page, rng, cursor, humanize: pipeline.record.humanize };

  const scenesMeta = [];
  let rawVideoPath = null;
  let wallSpanMs = 0;

  try {
    await waitForPyodide(page, pipeline.app);

    for (const scene of pipeline.scenes) {
      log.step(`Scene "${scene.id}"${scene.description ? ` — ${scene.description}` : ''}`);

      // ── Setup phase — pre-clock. Same timeline shape (events with `at` in
      // seconds from setup start), so authors can stagger setup steps too.
      if (Array.isArray(scene.setup) && scene.setup.length > 0) {
        await runEvents(scene.setup, page, (ev) => runEvent(ev, ctx), { label: '  setup' });
      }

      const settleMs = scene.settleMs ?? pipeline.record.settleMs;
      if (settleMs) await page.waitForTimeout(settleMs);

      // Measure the capture region once layout has settled.
      const bbox = await resolveTarget(page, scene.target, pipeline.app.viewport);
      log.info(`  region ${bbox.width}x${bbox.height} @ (${bbox.x},${bbox.y})`);

      // ── Scene clock starts here. Flatten all tracks; sort by `at`; dispatch.
      const focusKeyframes = [];
      const tracks = scene.tracks || {};

      // Camera track: use the manual track, OR auto-generate one from the
      // input actions (Screen Studio-style) when autoZoom is on. `autoCamera`
      // on a scene forces/disables it explicitly.
      let cameraEvents = tracks.camera || [];
      const az = pipeline.record.autoZoom || {};
      const wantAuto = scene.autoCamera === true
        || (az.enabled && scene.autoCamera !== false && cameraEvents.length === 0);
      if (wantAuto) {
        cameraEvents = buildAutoCamera(tracks.input || [], az);
        log.info(`  auto-camera: ${cameraEvents.length} keyframes from ${(tracks.input || []).length} input events`);
      }

      const events = [];
      const inputTrack = tracks.input || [];
      for (let i = 0; i < inputTrack.length; i++) events.push({ ...inputTrack[i], _track: 'input', _idx: i });
      for (const ev of cameraEvents) events.push({ ...ev, _track: 'camera' });
      for (const name of ['reveal', 'attention']) {
        for (const ev of (tracks[name] || [])) events.push({ ...ev, _track: name });
      }

      const startMs = Date.now() - recordingStartedAt;
      // Actual wall-clock fire time of each input event (recording-relative ms),
      // captured as it fires. Auto-camera keyframes anchor their timing to these
      // so durations stay exact while triggers track reality.
      const inputFireAbsMs = new Array(inputTrack.length).fill(undefined);

      // Custom dispatcher: camera events emit pan keyframes; reveal/attention
      // are reserved track types (forward-compatible, runtime not yet built).
      const focusCache = new Map(); // focusGroup -> resolved point, so the
      // close-up stays pixel-locked (one position for the whole zoomed phase).
      const dispatch = async (ev) => {
        if (ev._track === 'camera') {
          let pt;
          if (ev.focusGroup && focusCache.has(ev.focusGroup)) {
            pt = focusCache.get(ev.focusGroup);
          } else {
            pt = await resolveCameraPoint(page, ev);
            if (ev.focusGroup && pt) focusCache.set(ev.focusGroup, pt);
          }
          if (!pt) {
            log.warn(`  camera kf @${(ev.at || 0).toFixed(2)}s skipped: no target`);
            return;
          }
          // Resolve the POSITION live (the element must exist now), but DEFER
          // the time: it's computed after the run from the actual fire time of
          // the anchoring input event + the keyframe's exact offset. Sampling
          // Date.now() here would let serial-execution drift (slow typing,
          // cursor travel) stretch/crush the designed zoom durations and let the
          // pull-out fire before the result is really clicked.
          focusKeyframes.push({
            _tAnchor: ev.tAnchor || null,
            _planAt: ev.at || 0,
            _seg: ev.seg, // hotspot id — keeps each zoom segment atomic
            cx: pt.cx,
            cy: pt.cy,
            zoom: ev.zoom,
            ease: ev.ease || 'cubic-in-out',
          });
          return;
        }
        if (ev._track === 'attention') {
          const ok = await page.evaluate(({ kind, sel, amount, padding, durationMs }) => {
            const a = window.__attention;
            if (!a) return false;
            if (kind === 'spotlight') return a.spotlight(sel);
            if (kind === 'pulse')     return a.pulse(sel);
            if (kind === 'mark')      return a.mark(sel, { padding, durationMs });
            if (kind === 'dim')       { a.dim(amount); return true; }
            if (kind === 'release')   { a.release(); return true; }
            return false;
          }, { kind: ev.type, sel: ev.selector, amount: ev.amount, padding: ev.padding, durationMs: ev.durationMs });
          if (!ok) log.warn(`  attention @${(ev.at || 0).toFixed(2)}s ${ev.type} skipped`);
          // Auto-release after `durationSec` if specified on a spotlight/dim.
          if (ev.durationSec && (ev.type === 'spotlight' || ev.type === 'dim')) {
            setTimeout(() => {
              page.evaluate(() => window.__attention && window.__attention.release()).catch(() => {});
            }, ev.durationSec * 1000);
          }
          return;
        }
        if (ev._track === 'reveal') {
          log.warn(`  reveal track not yet implemented (event: ${ev.type || 'untyped'})`);
          return;
        }
        // input track — also handle cameraFollow side-effect.
        if (ev.cameraFollow) {
          const pt = await resolveInputPoint(page, ev);
          if (pt) {
            focusKeyframes.push({
              tMs: Date.now() - recordingStartedAt,
              cx: pt.cx,
              cy: pt.cy,
              ease: ev.cameraFollowEase || 'cubic-in-out',
            });
          }
        }
        await runEvent(ev, ctx);
        // Stamp the actual fire time (after the action completes — e.g. the
        // menu is open, the result is clicked) so the camera can anchor to it.
        if (typeof ev._idx === 'number') inputFireAbsMs[ev._idx] = Date.now() - recordingStartedAt;
      };

      const sceneStartWall = Date.now();
      await runEvents(events, page, dispatch, { label: '  live' });

      // Resolve deferred camera-keyframe times from actual input fire times.
      // tMs = (when the anchor event really fired) + (exact designed offset),
      // falling back to the plan if the anchor never fired.
      for (const kf of focusKeyframes) {
        if (!('_tAnchor' in kf)) continue; // cameraFollow keyframe — tMs already set
        const a = kf._tAnchor;
        const fired = a && typeof a.ref === 'number' ? inputFireAbsMs[a.ref] : undefined;
        kf.tMs = fired != null ? fired + (a.offsetMs || 0) : startMs + (kf._planAt || 0) * 1000;
      }

      // Keep each hotspot's zoom segment ATOMIC. Under drift / back-to-back
      // execution a segment's pull-out can land after the NEXT segment's
      // zoom-in, so a naive sort interleaves them and the camera shakes between
      // two targets. Group by `_seg`, order segments, and clamp each pull-out to
      // finish before the next segment begins (preserving the zoom-out duration
      // where possible, compressing only if forced).
      const segMap = new Map();
      for (const kf of focusKeyframes) {
        if (kf._seg == null) continue;
        if (!segMap.has(kf._seg)) segMap.set(kf._seg, []);
        segMap.get(kf._seg).push(kf);
      }
      const segs = [...segMap.values()].map((a) => a.sort((p, q) => p.tMs - q.tMs));
      segs.sort((a, b) => a[0].tMs - b[0].tMs);
      for (let i = 0; i < segs.length - 1; i++) {
        const cur = segs[i];
        const nextStart = segs[i + 1][0].tMs;
        const outEnd = cur[cur.length - 1];   // pull-out → rest
        const outStart = cur[cur.length - 2]; // hold → start of pull-out
        const inEnd = cur[cur.length - 3];    // focus reached
        if (outEnd && outStart && inEnd && outEnd.tMs > nextStart) {
          const outDur = outEnd.tMs - outStart.tMs;
          outEnd.tMs = nextStart;
          outStart.tMs = Math.max(inEnd.tMs, outEnd.tMs - outDur);
        }
      }

      // Final order + monotonic safety net.
      focusKeyframes.sort((p, q) => p.tMs - q.tMs);
      for (let i = 1; i < focusKeyframes.length; i++) {
        if (focusKeyframes[i].tMs < focusKeyframes[i - 1].tMs) focusKeyframes[i].tMs = focusKeyframes[i - 1].tMs;
      }
      for (const kf of focusKeyframes) { delete kf._tAnchor; delete kf._planAt; delete kf._seg; }

      // Hold until durationSec fully elapses (events may have finished earlier).
      const durationMs = (scene.durationSec || 0) * 1000;
      const elapsed = Date.now() - sceneStartWall;
      if (durationMs > elapsed) await page.waitForTimeout(durationMs - elapsed);

      // Optional extra hold AFTER the scene clock.
      if (scene.holdAfterSec) await page.waitForTimeout(scene.holdAfterSec * 1000);

      const endMs = Date.now() - recordingStartedAt;
      log.ok(`  held ${endMs - startMs}ms`);

      scenesMeta.push({
        id: scene.id,
        description: scene.description || '',
        startMs,
        endMs,
        bbox,
        fitMode: scene.fitMode || pipeline.output.fitMode,
        focusKeyframes,
      });
    }
  } finally {
    const video = page.video();
    wallSpanMs = Date.now() - recordingStartedAt;
    await context.close();
    if (video) {
      try { rawVideoPath = await video.path(); } catch { /* may be missing on early failure */ }
    }
    await browser.close();
  }

  return { scenesMeta, rawVideoPath, wallSpanMs };
}

async function main() {
  const cli = parseCli();
  const pipeline = loadPipeline(cli.pipelinePath);

  if (cli.headless !== undefined) pipeline.record.headless = cli.headless;
  if (cli.outDir) pipeline.output.dir = cli.outDir;
  if (cli.url) pipeline.app.url = cli.url;

  const runId = `${pipeline.name}-${timestamp()}`;
  const runDir = path.resolve(pipeline.output.dir, runId);
  const rawDir = path.join(runDir, 'raw');
  const scenesDir = path.join(runDir, 'scenes');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(scenesDir, { recursive: true });

  log.info(`Pipeline "${pipeline.name}" — ${pipeline.scenes.length} scene(s)`);
  log.info(`Run output: ${runDir}`);

  const { scenesMeta, rawVideoPath, wallSpanMs } = await recordSession(pipeline, {
    headless: pipeline.record.headless,
    rawDir,
  });

  if (!rawVideoPath) throw new Error('Playwright produced no raw video (recording failed before any scene)');
  log.ok('Raw session video ready');

  const rawDuration = await ffprobeDuration(rawVideoPath);
  log.info(`Raw duration ${rawDuration.toFixed(2)}s — slicing ${scenesMeta.length} scene(s)`);

  const rawDurationMs = rawDuration * 1000;
  const scale = wallSpanMs > 0 ? rawDurationMs / wallSpanMs : 1;
  const offset = pipeline.record.timelineOffsetMs || 0;
  const results = [];

  for (const meta of scenesMeta) {
    const startMs = Math.max(0, meta.startMs * scale + offset);
    const endMs = Math.min(rawDurationMs, meta.endMs * scale + offset);
    const clip = path.join(scenesDir, `${meta.id}.mp4`);
    // `lockX` pins the camera horizontally to the capture region's centre, so
    // the zoom only moves vertically + scales (no left/right panning).
    const lockX = !!(pipeline.record.autoZoom && pipeline.record.autoZoom.lockX);
    const centerX = meta.bbox.x + meta.bbox.width / 2;
    const pan = meta.focusKeyframes && meta.focusKeyframes.length
      ? meta.focusKeyframes.map((kf) => ({
          tSec: Math.max(0, ((kf.tMs - meta.startMs) * scale) / 1000),
          cx: lockX ? centerX : kf.cx,
          cy: kf.cy,
          zoom: kf.zoom,
          ease: kf.ease || 'linear',
        }))
      : undefined;
    log.step(`Cropping "${meta.id}" → scenes/${meta.id}.mp4${pan ? ` (pan: ${pan.length} keyframes)` : ''}`);
    try {
      await cropScene({
        rawVideo: rawVideoPath,
        startMs,
        endMs,
        bbox: meta.bbox,
        output: clip,
        resolution: pipeline.output.resolution,
        fps: pipeline.output.fps,
        fitMode: meta.fitMode,
        pan,
        videoSize: pipeline.app.viewport,
      });
      results.push({ ...meta, startMs, endMs, clip, status: 'ok' });
      log.ok(`  scenes/${meta.id}.mp4`);
    } catch (err) {
      results.push({ ...meta, startMs, endMs, clip, status: 'failed', error: err.message });
      log.error(`  "${meta.id}" failed: ${err.message}`);
    }
  }

  const manifest = {
    pipeline: pipeline.name,
    generatedAt: new Date().toISOString(),
    app: pipeline.app,
    resolution: pipeline.output.resolution,
    fps: pipeline.output.fps,
    rawDurationSec: rawDuration,
    rawVideo: pipeline.output.keepRaw ? rawVideoPath : null,
    scenes: results,
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log.ok(`Manifest: ${path.join(runDir, 'manifest.json')}`);

  if (!pipeline.output.keepRaw) {
    fs.rmSync(rawDir, { recursive: true, force: true });
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  log.info(`Done — ${okCount}/${results.length} clip(s) in ${scenesDir}`);
  if (okCount !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  log.error(err.stack || String(err));
  process.exit(1);
});
