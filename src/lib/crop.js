// ffmpeg layer: probe the raw session video and slice/crop each scene into a
// vertical clip.
//
// A scene clip is produced by:
//   1. seeking to [startMs, endMs]
//   2. cropping to the scene's region (bbox) — fixed, OR a window that PANS
//      between `pan` keyframes (camera-follows-the-action)
//   3. mapping that region onto the output resolution (cover or contain)

import { spawn } from 'node:child_process';
import { FFMPEG, FFPROBE } from '../config.js';
import { easeFFmpeg } from './humanize.js';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      reject(new Error(`Failed to start ${bin}: ${err.message}. Is it on PATH?`));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}\n${stderr.split('\n').slice(-12).join('\n')}`));
    });
  });
}

// Duration of a media file, in seconds.
export async function ffprobeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read duration of ${file}`);
  return seconds;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Piecewise ffmpeg expression over `t` (seconds): holds the first value
// before the first keyframe, eases between keyframes, holds the last after.
// keyframes: [{ t, v, ease? }] sorted by t — `ease` is the curve used to
// arrive AT this keyframe from the previous one (defaults to 'linear').
// `fixed` controls value precision — integers for pixel coords, decimals for
// zoom factors.
function piecewiseExpr(keyframes, fixed = 0) {
  const fmt = (v) => (fixed === 0 ? String(Math.round(v)) : Number(v).toFixed(fixed));
  if (keyframes.length === 1) return fmt(keyframes[0].v);
  let expr = fmt(keyframes[keyframes.length - 1].v);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    const sExpr = `((t-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    const eased = (easeFFmpeg[b.ease] || easeFFmpeg.linear)(sExpr);
    const seg = `(${fmt(a.v)}+(${fmt(b.v)}-${fmt(a.v)})*${eased})`;
    expr = `if(lte(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lte(t,${keyframes[0].t.toFixed(3)}),${fmt(keyframes[0].v)},${expr})`;
}

// Static crop region -> "crop=W:H:X:Y".
function staticCrop(bbox) {
  return `crop=${bbox.width}:${bbox.height}:${bbox.x}:${bbox.y}`;
}

// Panning crop (no zoom): a bbox-sized window whose top-left follows `pan`
// keyframes. pan: [{ tSec, cx, cy, ease? }] — desired window CENTRE at scene-
// relative time tSec, with optional ease curve used to arrive at this keyframe.
function panCropStatic(bbox, pan, videoSize) {
  const maxX = Math.max(0, videoSize.width - bbox.width);
  const maxY = Math.max(0, videoSize.height - bbox.height);
  const sorted = [...pan].sort((a, b) => a.tSec - b.tSec);
  const xKfs = sorted.map((k) => ({
    t: Math.max(0, k.tSec),
    v: clamp(k.cx - bbox.width / 2, 0, maxX),
    ease: k.ease || 'linear',
  }));
  const yKfs = sorted.map((k) => ({
    t: Math.max(0, k.tSec),
    v: clamp(k.cy - bbox.height / 2, 0, maxY),
    ease: k.ease || 'linear',
  }));
  // Single-quote the expressions so their commas aren't read as filter separators.
  return `crop=${bbox.width}:${bbox.height}:x='${piecewiseExpr(xKfs)}':y='${piecewiseExpr(yKfs)}'`;
}

// Pan crop for the zoom path: a bbox-sized window that pans HORIZONTALLY to
// follow the camera centre, but is fixed vertically at bbox.y. The bbox is
// nearly as tall as the video, so there's no vertical room to pan here anyway
// — vertical focus is handled by the zoompan stage instead (which centres its
// zoom window on the camera's cy).
function panCropXOnly(bbox, pan, videoSize) {
  const maxX = Math.max(0, videoSize.width - bbox.width);
  const sorted = [...pan].sort((a, b) => a.tSec - b.tSec);
  const xKfs = sorted.map((k) => ({
    t: Math.max(0, k.tSec),
    v: clamp(k.cx - bbox.width / 2, 0, maxX),
    ease: k.ease || 'linear',
  }));
  return `crop=${bbox.width}:${bbox.height}:x='${piecewiseExpr(xKfs)}':y=${bbox.y}`;
}

// Zoompan stage. The preceding `crop` carved a bbox-sized 9:16 window that
// follows the camera centre HORIZONTALLY (so the target sits at the window's
// horizontal centre). Here we zoom in: zoompan crops `iw/z × ih/z` and scales
// to `s`. ffmpeg's `crop` can't animate w/h per-frame (eval=init only), so
// zoompan is the right tool. CRITICAL: the zoom window must follow the
// camera's VERTICAL target (cy) — otherwise it centres on the bbox middle
// (empty canvas) regardless of where the action is. zoompan exposes `on`
// (output frame number), not `t`, so we map `t -> on/fps`.
function zoompanStage(bbox, pan, resolution, fps) {
  const sorted = [...pan].sort((a, b) => a.tSec - b.tSec);
  const zKfs = sorted.map((k) => ({
    t: Math.max(0, k.tSec),
    v: Math.max(1, k.zoom || 1),
    ease: k.ease || 'linear',
  }));
  // Target cy expressed in the pre-cropped window's coordinate space (the
  // window starts at video-y = bbox.y).
  const cyKfs = sorted.map((k) => ({
    t: Math.max(0, k.tSec),
    v: k.cy - bbox.y,
    ease: k.ease || 'linear',
  }));
  const zExpr = piecewiseExpr(zKfs, 4).replace(/\bt\b/g, `(on/${fps})`);
  const cyExpr = piecewiseExpr(cyKfs).replace(/\bt\b/g, `(on/${fps})`);
  // Horizontal: the pre-crop already centres the target, so centre the zoom.
  const xExpr = `(iw*(zoom-1))/(2*zoom)`;
  // Vertical: centre the zoom window on cy, clamped inside the input frame.
  const yExpr = `max(0,min(ih-ih/zoom,(${cyExpr})-(ih/zoom)/2))`;
  return `zoompan=z='${zExpr}':d=1:s=${resolution.width}x${resolution.height}:x='${xExpr}':y='${yExpr}':fps=${fps}`;
}

function buildFilter({ bbox, pan, videoSize, resolution, fps, fitMode, speed = 1 }) {
  const { width: rw, height: rh } = resolution;
  // Reset PTS so the crop filter's `t` is clip-relative (0-based).
  const resetPts = 'setpts=PTS-STARTPTS';
  // Time-compress the finished clip for a punchy social-media pace. Applied
  // LAST: pan/zoom expressions use the input frame's `t`, so they animate at
  // authored timing; setpts then plays the whole thing `speed`× faster. `-r`
  // resamples to the target fps afterwards. (Pure video — no audio to resync.)
  const speedPts = speed && speed !== 1 ? [`setpts=PTS/${speed}`] : [];
  const hasZoom = pan && pan.some((k) => typeof k.zoom === 'number' && k.zoom !== 1);
  // lanczos = sharper upscaling than the default bilinear; zoom amplifies any
  // softness, so use it on every scale stage.
  const sws = 'flags=lanczos';

  if (hasZoom) {
    // Zoom path: horizontal-pan crop → fps-normalise → zoompan (zooms toward
    // cy and scales to the output resolution itself, so no post-scale stage).
    return [
      resetPts,
      panCropXOnly(bbox, pan, videoSize),
      `fps=${fps}`,
      zoompanStage(bbox, pan, resolution, fps),
      ...speedPts,
    ].join(',');
  }

  // Fast path: static or pan-only crop, then scale/pad to output.
  const cropRegion = pan && pan.length ? panCropStatic(bbox, pan, videoSize) : staticCrop(bbox);
  if (fitMode === 'contain') {
    return [
      resetPts,
      cropRegion,
      `scale=${rw}:${rh}:force_original_aspect_ratio=decrease:${sws}`,
      `pad=${rw}:${rh}:(ow-iw)/2:(oh-ih)/2:color=black`,
      ...speedPts,
    ].join(',');
  }
  // cover: scale to fill the frame, then centre-crop the overflow.
  return [
    resetPts,
    cropRegion,
    `scale=${rw}:${rh}:force_original_aspect_ratio=increase:${sws}`,
    `crop=${rw}:${rh}`,
    ...speedPts,
  ].join(',');
}

// Slice + crop one scene. Times are in milliseconds relative to raw video t0.
// `pan` (optional) makes the crop window follow keyframes; if any keyframe has
// a `zoom`, the window also zooms via a zoompan stage.
export async function cropScene({ rawVideo, startMs, endMs, bbox, output, resolution, fps, fitMode, pan, videoSize, speed = 1 }) {
  const start = Math.max(0, startMs) / 1000;
  const duration = Math.max(0.1, (endMs - startMs) / 1000);
  const filter = buildFilter({ bbox, pan, videoSize, resolution, fps, fitMode, speed });

  const args = [
    '-y',
    // `-ss` BEFORE `-i` is input seeking: it resets the decoded frames'
    // timestamps to ~0, so the crop filter's `t` is clip-relative and the
    // pan expressions line up with their (scene-relative) keyframe times.
    // (`-ss` after `-i` keeps the raw video's original timestamps — then
    // `t` is always past every keyframe and the pan window stays pinned.)
    '-sws_flags', 'lanczos',
    '-ss', start.toFixed(3),
    '-i', rawVideo,
    '-t', duration.toFixed(3),
    '-vf', filter,
    '-r', String(fps),
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    // CRF 18 ≈ visually near-lossless; the zoom upscale needs the headroom.
    '-crf', '18',
    '-preset', 'slow',
    '-tune', 'film',
    '-movflags', '+faststart',
    output,
  ];

  await run(FFMPEG, args);
  return output;
}
