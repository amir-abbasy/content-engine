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
import { parseCli, numOpt, ROOT } from './config.js';
import { getStrategy } from '../scripts/lib/build-flow.js';
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

const boxOf = (page, sel) =>
  page.locator(sel).first().boundingBox({ timeout: CAMERA_RESOLVE_TIMEOUT_MS }).catch(() => null);

// Resolve a camera event's keyframe coords. Three forms:
//   • `point`      — explicit { x, y }.
//   • `framePair`  — { a, b } two selectors (e.g. a wiring drag's source +
//                    target handles): centre on their union and return a `zoom`
//                    that makes BOTH fit inside the capture region (so the
//                    connection is readable). Falls back to `focusSelector`.
//   • `selector`   — a single element (+ optional position offset).
async function resolveCameraPoint(page, ev, captureBox) {
  if (ev.point) return { cx: ev.point.x, cy: ev.point.y };
  if (ev.framePair) {
    let boxes = (await Promise.all([boxOf(page, ev.framePair.a), boxOf(page, ev.framePair.b)])).filter(Boolean);
    if (!boxes.length && ev.focusSelector) {
      const f = await boxOf(page, ev.focusSelector);
      if (f) boxes = [f];
    }
    if (!boxes.length) return null;
    const x1 = Math.min(...boxes.map((b) => b.x));
    const y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.width));
    const y2 = Math.max(...boxes.map((b) => b.y + b.height));
    let zoom;
    if (captureBox) {
      const pad = 90; // breathing room (source px) around the pair
      const zx = captureBox.width / ((x2 - x1) + 2 * pad);
      const zy = captureBox.height / ((y2 - y1) + 2 * pad);
      zoom = Math.max(0.3, Math.min(zx, zy)); // never below 0.3 (full-flow view)
    }
    return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, zoom };
  }
  if (!ev.selector) return null;
  const loc = page.locator(ev.selector);
  let box = await (ev.nth !== undefined ? loc.nth(ev.nth) : loc.first())
    .boundingBox({ timeout: CAMERA_RESOLVE_TIMEOUT_MS }).catch(() => null);
  // A transient target (e.g. the colour [role="dialog"], open only between the
  // swatch-click and the pick) may be gone when this keyframe resolves. Fall
  // back to a stable element (the node) so the keyframe survives — otherwise it
  // is dropped and the camera drifts across the gap instead of holding.
  if (!box && ev.fallbackSelector) {
    box = await page.locator(ev.fallbackSelector).first()
      .boundingBox({ timeout: CAMERA_RESOLVE_TIMEOUT_MS }).catch(() => null);
  }
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
  const { browser, context, page, recordingStartedAt, fxConfig } = await launchRecorder({ pipeline, rawDir, headless });
  const rng = createRng(pipeline.record.humanize?.seed ?? 1);
  const cursor = createCursorDriver(page, rng, pipeline.record.cursor || {});
  const ctx = { page, rng, cursor, humanize: pipeline.record.humanize };

  const scenesMeta = [];
  let rawVideoPath = null;
  let wallSpanMs = 0;

  try {
    await waitForPyodide(page, pipeline.app);

    for (let sceneIdx = 0; sceneIdx < pipeline.scenes.length; sceneIdx++) {
      const scene = pipeline.scenes[sceneIdx];
      log.step(`Scene "${scene.id}"${scene.description ? ` — ${scene.description}` : ''}`);

      // Pick the cinematic effects theme for this scene: an explicit
      // `scene.effects` (string theme, or { theme, palette }) wins; otherwise a
      // "sequence" run rotates through the theme list per scene. Either way we
      // just nudge the live engine (window.__fx) before the scene's clicks fire.
      const sceneFx = scene.effects;
      let fxTheme = typeof sceneFx === 'string' ? sceneFx : (sceneFx && sceneFx.theme) || null;
      const fxPalette = (sceneFx && typeof sceneFx === 'object') ? sceneFx.palette : null;
      if (!fxTheme && fxConfig && fxConfig.sequence && fxConfig.sequence.length) {
        fxTheme = fxConfig.sequence[sceneIdx % fxConfig.sequence.length];
      }
      if (fxTheme || fxPalette) {
        const applied = await page.evaluate(({ t, pal }) => {
          if (!window.__fx) return null;
          if (t) window.__fx.setTheme(t);
          if (pal) window.__fx.setPalette(pal);
          return window.__fx.theme;
        }, { t: fxTheme, pal: fxPalette }).catch(() => null);
        if (applied) log.info(`  effects: ${applied}${fxPalette ? ` / ${fxPalette}` : ''}`);
      }

      // Pre-measure the on-screen CENTRE of each node an add-right-click will
      // create. The app fits the viewport deterministically to the full
      // fixture, so injecting it once lets us read exact node centres. A
      // context-menu add places the new node CENTRED on the click and the
      // follow-up injectFlow snaps it to that same fixture position — so
      // right-clicking at the measured centre means the node lands exactly where
      // it's shown (no jump), and the camera that rests on it frames the right
      // spot. Done before the scene clock, so this probe isn't in the clip.
      const addCenters = new Map();
      const addClicks = (scene.tracks?.input || []).filter((e) => e.type === 'rightClick' && e.addsNodeId != null);
      if (addClicks.length) {
        const inj = (scene.setup || []).find((e) => e.type === 'injectFlow' && e.file && e.nodeCount === undefined);
        if (inj) {
          await page.keyboard.press('Shift+Digit2');
          await runEvent({ type: 'injectFlow', file: inj.file }, ctx);
          await page.waitForTimeout(500);
          const ids = [...new Set(addClicks.map((e) => String(e.addsNodeId)))];
          const centers = await page.evaluate((nodeIds) => {
            const o = {};
            for (const id of nodeIds) {
              const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
              if (el) { const r = el.getBoundingClientRect(); o[id] = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
            }
            return o;
          }, ids);
          for (const id of ids) if (centers[id]) addCenters.set(id, centers[id]);
          log.info(`  measured ${addCenters.size} add-node centre(s): ${[...addCenters.entries()].map(([k, v]) => `#${k}(${v.x | 0},${v.y | 0})`).join(' ')}`);
        }
      }

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
            pt = await resolveCameraPoint(page, ev, bbox);
            if (ev.focusGroup && pt) focusCache.set(ev.focusGroup, pt);
          }
          if (!pt) {
            log.warn(`  camera kf @${(ev.at || 0).toFixed(2)}s skipped: no target`);
            return;
          }
          // Diagnostic: a resolved point outside the captured frame means the
          // element was off-screen at resolution time (drift / transient state).
          // The camera would fly off and the crop would clamp to the edge.
          const vw = pipeline.app.viewport.width, vh = pipeline.app.viewport.height;
          if (pt.cx < 0 || pt.cx > vw || pt.cy < 0 || pt.cy > vh) {
            const tf = await page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform || '?').catch(() => '?');
            log.warn(`  camera kf @${(ev.at || 0).toFixed(2)}s OFF-SCREEN (${ev.selector || 'point'}) -> cx=${pt.cx.toFixed(0)} cy=${pt.cy.toFixed(0)} | ${tf}`);
          }
          // Resolve the POSITION live (the element must exist now), but DEFER
          // the time: it's computed after the run from the actual fire time of
          // the anchoring input event + the keyframe's exact offset. Sampling
          // Date.now() here would let serial-execution drift (slow typing,
          // cursor travel) stretch/crush the designed zoom durations and let the
          // pull-out fire before the result is really clicked.
          // A `framePair` keyframe carries its own fit-zoom. Use it only for the
          // ZOOMED-IN keyframes (ev.zoom > rest); rest/arrive keyframes keep
          // restZoom. Never zoom in TIGHTER than requested — `min` keeps both
          // endpoints in frame (far pairs zoom out; close pairs stay at ev.zoom).
          const useZoom = (pt.zoom != null && ev.zoom > 1.0001) ? Math.min(ev.zoom, pt.zoom) : ev.zoom;
          focusKeyframes.push({
            _tAnchor: ev.tAnchor || null,
            _planAt: ev.at || 0,
            _seg: ev.seg, // hotspot id — keeps each zoom segment atomic
            cx: pt.cx,
            cy: pt.cy,
            zoom: useZoom,
            ease: ev.ease || 'cubic-in-out',
          });
          return;
        }
        if (ev._track === 'attention') {
          const ok = await page.evaluate(({ kind, sel, amount, padding, durationMs, nth }) => {
            const a = window.__attention;
            if (!a) return false;
            if (kind === 'spotlight') return a.spotlight(sel);
            if (kind === 'pulse')     return a.pulse(sel);
            if (kind === 'mark')      return a.mark(sel, { padding, durationMs, nth });
            if (kind === 'dim')       { a.dim(amount); return true; }
            if (kind === 'release')   { a.release(); return true; }
            return false;
          }, { kind: ev.type, sel: ev.selector, amount: ev.amount, padding: ev.padding, durationMs: ev.durationMs, nth: ev.nth });
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
        // A context-menu add right-click fires at the measured centre of the
        // node it will create, so the node lands exactly where it's shown.
        if (ev.type === 'rightClick' && ev.addsNodeId != null && addCenters.has(String(ev.addsNodeId))) {
          ev = { ...ev, point: addCenters.get(String(ev.addsNodeId)) };
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

      // Per-node boundaries: when each add-right-click actually fired, plus the
      // last input fire (the Execute click). The post/compose stage uses these
      // to slice the clip into per-node segments and time-stretch each to its
      // narration window. Recording-relative ms; converted to clip-seconds below.
      const addFires = inputTrack
        .map((e, i) => (e.type === 'rightClick' && e.addsNodeId != null ? { execId: String(e.addsNodeId), atMs: inputFireAbsMs[i] } : null))
        .filter((f) => f && f.atMs != null);
      const lastFireMs = inputFireAbsMs.reduce((m, v) => (v != null && v > m ? v : m), startMs);

      // Sound-effect cues: the actual fire time of each interaction, plus zoom
      // transitions derived from the camera keyframes. The compose stage remaps
      // these through the per-beat speed and drops a sound at each.
      const SFX_TYPES = new Set(['click', 'rightClick', 'dblclick', 'drag', 'fill']);
      const eventFires = inputTrack
        .map((e, i) => (SFX_TYPES.has(e.type) && inputFireAbsMs[i] != null ? { type: e.type, atMs: inputFireAbsMs[i] } : null))
        .filter(Boolean);
      const zoomCues = [];
      for (let i = 1; i < focusKeyframes.length; i++) {
        const dz = (focusKeyframes[i].zoom || 1) - (focusKeyframes[i - 1].zoom || 1);
        const type = dz > 0.05 ? 'zoomIn' : dz < -0.05 ? 'zoomOut' : null;
        if (!type) continue;
        const atMs = focusKeyframes[i - 1].tMs; // sound starts as the move begins
        const last = zoomCues[zoomCues.length - 1];
        if (last && last.type === type && atMs - last.atMs < 200) continue; // dedup a multi-kf rise
        zoomCues.push({ type, atMs });
      }

      scenesMeta.push({
        id: scene.id,
        description: scene.description || '',
        startMs,
        endMs,
        bbox,
        fitMode: scene.fitMode || pipeline.output.fitMode,
        focusKeyframes,
        addFires,
        lastFireMs,
        eventFires,
        zoomCues,
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

  // `flow=<name>`: one name selects the generated pipeline AND a fixed output
  // dir (output/<name>, no timestamp — overwrites in place). Derived from the
  // same strategy table the generators use, so paths never drift.
  let fixedRunDir;
  if (cli.flow) {
    const s = getStrategy(cli.flow);
    cli.pipelinePath = path.resolve(ROOT, s.pipelineOut);
    fixedRunDir = path.resolve(ROOT, s.outDir);
    log.info(`Flow "${cli.flow}": pipeline ${s.pipelineOut} → output ${s.outDir}`);
  }

  const pipeline = loadPipeline(cli.pipelinePath);

  if (cli.headless !== undefined) pipeline.record.headless = cli.headless;
  if (cli.outDir) pipeline.output.dir = cli.outDir;
  if (cli.url) pipeline.app.url = cli.url;

  // Scene filter (`s=3` or `--scene 3`): record ONLY the selected scene. Each
  // scene is self-contained (its setup rebuilds the prior flow state via
  // injectFlow), so a single scene records correctly in isolation — handy for
  // iterating on one scene without re-running the whole pipeline.
  if (cli.scene !== undefined) {
    const sel = String(cli.scene).trim();
    const all = pipeline.scenes;
    let picked = /^\d+$/.test(sel) ? all[Number(sel) - 1] : undefined;
    if (!picked) picked = all.find((s) => s.id === sel) || all.find((s) => s.id.includes(sel));
    if (!picked) {
      throw new Error(`Scene "${sel}" not found. Available: ${all.map((s, i) => `${i + 1}=${s.id}`).join(', ')}`);
    }
    pipeline.scenes = [picked];
    log.info(`Scene filter: recording only "${picked.id}"`);
  }

  // Speed-up controls: CLI flag > env var > pipeline.json > built-in default.
  const speedOverride = cli.speed ?? numOpt(process.env.OUTPUT_SPEED);
  if (speedOverride !== undefined) pipeline.output.speed = speedOverride;
  const maxTotalOverride = cli.maxTotalSec ?? numOpt(process.env.OUTPUT_MAX_TOTAL_SEC);
  if (maxTotalOverride !== undefined) pipeline.output.maxTotalSec = maxTotalOverride;

  // Fixed dir for a named flow (overwrite in place); otherwise a timestamped run.
  const runDir = fixedRunDir || path.resolve(pipeline.output.dir, `${pipeline.name}-${timestamp()}`);
  if (fixedRunDir) fs.rmSync(runDir, { recursive: true, force: true });
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

  // Playback speed-up for a social-media pace. `output.speed` is an explicit
  // multiplier; `output.maxTotalSec` auto-derives a speed so the FINAL video
  // (sum of all clips) fits the cap — whichever is larger wins. Computed once
  // and applied uniformly to every scene so motion stays consistent.
  const sceneRawSec = scenesMeta.map((m) => {
    const st = Math.max(0, m.startMs * scale + offset);
    const en = Math.min(rawDurationMs, m.endMs * scale + offset);
    return Math.max(0, (en - st) / 1000);
  });
  const totalRawSec = sceneRawSec.reduce((a, b) => a + b, 0);
  let speed = pipeline.output.speed || 1;
  if (pipeline.output.maxTotalSec && totalRawSec > 0) {
    speed = Math.max(speed, totalRawSec / pipeline.output.maxTotalSec, 1);
  }
  if (speed !== 1) log.info(`Speed-up ×${speed.toFixed(2)} (raw ${totalRawSec.toFixed(1)}s → ~${(totalRawSec / speed).toFixed(1)}s)`);

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
        speed,
      });
      // Node boundaries in the FINISHED clip's own timeline (seconds): raw fire
      // time, scaled to the raw video, shifted to the clip start, divided by the
      // applied speed. The compose stage slices on these.
      const toClipSec = (fireMs) => Math.max(0, (((fireMs - meta.startMs) * scale) / 1000) / speed);
      const addBoundaries = (meta.addFires || []).map((f) => ({ execId: f.execId, clipSec: toClipSec(f.atMs) }));
      const actionsEndSec = toClipSec(meta.lastFireMs || meta.endMs);
      const clipDurationSec = Math.max(0, ((endMs - startMs) / 1000) / speed);
      const sfxCues = [...(meta.eventFires || []), ...(meta.zoomCues || [])]
        .map((e) => ({ type: e.type, clipSec: toClipSec(e.atMs) }))
        .filter((c) => c.clipSec >= 0 && c.clipSec <= clipDurationSec + 0.5)
        .sort((a, b) => a.clipSec - b.clipSec);
      results.push({ ...meta, startMs, endMs, clip, status: 'ok', addBoundaries, actionsEndSec, clipDurationSec, sfxCues });
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
