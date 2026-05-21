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

// Resolve a camera event's keyframe coords (point or selector + optional position).
async function resolveCameraPoint(page, ev, viewport) {
  if (ev.point) return { cx: ev.point.x, cy: ev.point.y };
  if (!ev.selector) return null;
  const loc = page.locator(ev.selector).first();
  const box = await loc.boundingBox().catch(() => null);
  if (!box) {
    // Fallback to target.js's smarter resolver (handles pane keys etc.)
    const fb = await resolveTarget(page, { selector: ev.selector }, viewport).catch(() => null);
    if (!fb) return null;
    return { cx: fb.x + fb.width / 2, cy: fb.y + fb.height / 2 };
  }
  const pos = ev.position || { x: box.width / 2, y: box.height / 2 };
  return { cx: box.x + pos.x, cy: box.y + pos.y };
}

// Resolve the absolute coords for an input event's target — used by
// `cameraFollow` to drop a camera keyframe at the same spot the cursor is
// about to click.
async function resolveInputPoint(page, ev) {
  if (!ev.selector) return null;
  const loc = page.locator(ev.selector).first();
  const box = await loc.boundingBox().catch(() => null);
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
      const events = [];
      for (const name of ['input', 'camera', 'reveal', 'attention']) {
        for (const ev of (tracks[name] || [])) events.push({ ...ev, _track: name });
      }

      const startMs = Date.now() - recordingStartedAt;

      // Custom dispatcher: camera events emit pan keyframes; reveal/attention
      // are reserved track types (forward-compatible, runtime not yet built).
      const dispatch = async (ev) => {
        if (ev._track === 'camera') {
          const pt = await resolveCameraPoint(page, ev, pipeline.app.viewport);
          if (!pt) {
            log.warn(`  camera kf @${(ev.at || 0).toFixed(2)}s skipped: no target`);
            return;
          }
          focusKeyframes.push({
            tMs: Date.now() - recordingStartedAt,
            cx: pt.cx,
            cy: pt.cy,
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
      };

      const sceneStartWall = Date.now();
      await runEvents(events, page, dispatch, { label: '  live' });

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
    const pan = meta.focusKeyframes && meta.focusKeyframes.length
      ? meta.focusKeyframes.map((kf) => ({
          tSec: Math.max(0, ((kf.tMs - meta.startMs) * scale) / 1000),
          cx: kf.cx,
          cy: kf.cy,
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
