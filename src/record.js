// Content Engine — Phase 1 recorder.
//
// Opens the target app once, waits for Pyodide, then walks the pipeline's
// scenes in a single continuous recording. Afterwards the raw session video is
// sliced + cropped per scene into vertical (mobile-ratio) clips.
//
//   node src/record.js [pipeline.json] [--headed|--headless] [--out dir] [--url u]

import fs from 'node:fs';
import path from 'node:path';
import { parseCli } from './config.js';
import { loadPipeline } from './lib/pipeline.js';
import { launchRecorder, waitForPyodide } from './lib/browser.js';
import { runActions } from './lib/actions.js';
import { resolveTarget } from './lib/target.js';
import { cropScene, ffprobeDuration } from './lib/crop.js';
import { log } from './lib/log.js';

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // Readable: 2026-05-14_13-16-34  ->  output/algo-trading-reel-01-2026-05-14_13-16-34
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Drives the browser through every scene and returns timing + region metadata
// plus the path to the finalized raw session video.
async function recordSession(pipeline, { headless, rawDir }) {
  const { browser, context, page, recordingStartedAt } = await launchRecorder({ pipeline, rawDir, headless });
  const scenesMeta = [];
  let rawVideoPath = null;
  let wallSpanMs = 0;

  try {
    await waitForPyodide(page, pipeline.app);

    for (const scene of pipeline.scenes) {
      log.step(`Scene "${scene.id}"${scene.description ? ` — ${scene.description}` : ''}`);

      // setup runs BEFORE the scene clock — e.g. open the target pane.
      await runActions(page, scene.setup, 'setup');

      const settleMs = scene.settleMs ?? pipeline.record.settleMs;
      if (settleMs) await page.waitForTimeout(settleMs);

      // Measure the capture region once the layout has settled.
      const bbox = await resolveTarget(page, scene.target, pipeline.app.viewport);
      log.info(`  region ${bbox.width}x${bbox.height} @ (${bbox.x},${bbox.y})`);

      if (scene.waitBeforeMs) await page.waitForTimeout(scene.waitBeforeMs);

      // Scene clock starts here. `actions` run live, concurrently with the hold.
      const startMs = Date.now() - recordingStartedAt;
      // `focus` actions drop camera keyframes — the crop window pans between
      // them so it follows the action (e.g. each node as the flow is built).
      const focusKeyframes = [];
      const onFocus = async (action) => {
        try {
          const fb = await resolveTarget(page, { selector: action.selector }, pipeline.app.viewport);
          focusKeyframes.push({
            tMs: Date.now() - recordingStartedAt,
            cx: fb.x + fb.width / 2,
            cy: fb.y + fb.height / 2,
          });
        } catch (e) {
          log.warn(`  focus "${action.selector}" skipped: ${e.message}`);
        }
      };
      const actionsPromise = runActions(page, scene.actions, 'live', { onFocus }).catch((e) => {
        log.warn(`  live actions failed: ${e.message}`);
      });

      if (scene.durationMs !== undefined) {
        await page.waitForTimeout(scene.durationMs);
      } else if (scene.stopWhen) {
        try {
          await page.waitForSelector(scene.stopWhen.selector, {
            state: scene.stopWhen.state || 'visible',
            timeout: scene.stopWhen.timeoutMs ?? 30000,
          });
        } catch (e) {
          log.warn(`  stopWhen never met: ${e.message}`);
        }
      }
      await actionsPromise;

      // Optional static hold AFTER the live actions finish.
      if (scene.holdAfterMs) await page.waitForTimeout(scene.holdAfterMs);

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
    // Closing the context flushes + finalizes the .webm so its path resolves.
    const video = page.video();
    wallSpanMs = Date.now() - recordingStartedAt;
    await context.close();
    if (video) {
      try { rawVideoPath = await video.path(); } catch { /* recording may not exist on early failure */ }
    }
    await browser.close();
  }

  return { scenesMeta, rawVideoPath, wallSpanMs };
}

async function main() {
  const cli = parseCli();
  const pipeline = loadPipeline(cli.pipelinePath);

  // CLI overrides win over the pipeline file.
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
  log.ok(`Raw session video ready`);

  const rawDuration = await ffprobeDuration(rawVideoPath);
  log.info(`Raw duration ${rawDuration.toFixed(2)}s — slicing ${scenesMeta.length} scene(s)`);

  // Scene timestamps are wall-clock; the encoded video can run slightly
  // shorter/longer. Linearly map wall-clock -> video time so slices stay aligned.
  const rawDurationMs = rawDuration * 1000;
  const scale = wallSpanMs > 0 ? rawDurationMs / wallSpanMs : 1;
  const offset = pipeline.record.timelineOffsetMs || 0;
  const results = [];
  for (const meta of scenesMeta) {
    const startMs = Math.max(0, meta.startMs * scale + offset);
    const endMs = Math.min(rawDurationMs, meta.endMs * scale + offset);
    const clip = path.join(scenesDir, `${meta.id}.mp4`);
    // Camera-follow: map focus keyframes onto the clip's local (post-seek) timeline.
    const pan = meta.focusKeyframes && meta.focusKeyframes.length
      ? meta.focusKeyframes.map((kf) => ({
          tSec: Math.max(0, ((kf.tMs - meta.startMs) * scale) / 1000),
          cx: kf.cx,
          cy: kf.cy,
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
