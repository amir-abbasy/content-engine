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
function piecewiseExpr(keyframes) {
  if (keyframes.length === 1) return String(Math.round(keyframes[0].v));
  let expr = String(Math.round(keyframes[keyframes.length - 1].v));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    const sExpr = `((t-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    const eased = (easeFFmpeg[b.ease] || easeFFmpeg.linear)(sExpr);
    const av = Math.round(a.v);
    const bv = Math.round(b.v);
    const seg = `(${av}+(${bv}-${av})*${eased})`;
    expr = `if(lte(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lte(t,${keyframes[0].t.toFixed(3)}),${Math.round(keyframes[0].v)},${expr})`;
}

// Static crop region -> "crop=W:H:X:Y".
function staticCrop(bbox) {
  return `crop=${bbox.width}:${bbox.height}:${bbox.x}:${bbox.y}`;
}

// Panning crop: a bbox-sized window whose top-left follows `pan` keyframes.
// pan: [{ tSec, cx, cy, ease? }] — desired window CENTRE at scene-relative
// time tSec, with optional ease curve used to arrive at this keyframe.
function panCrop(bbox, pan, videoSize) {
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

function buildFilter({ bbox, pan, videoSize, resolution, fitMode }) {
  const { width: rw, height: rh } = resolution;
  const cropRegion = pan && pan.length ? panCrop(bbox, pan, videoSize) : staticCrop(bbox);
  // Reset PTS so the crop filter's `t` is clip-relative (0-based). Without this
  // `t` keeps the raw video's original timestamps and time-based pan
  // expressions never match their keyframe times.
  const resetPts = 'setpts=PTS-STARTPTS';
  if (fitMode === 'contain') {
    return [
      resetPts,
      cropRegion,
      `scale=${rw}:${rh}:force_original_aspect_ratio=decrease`,
      `pad=${rw}:${rh}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ].join(',');
  }
  // cover: scale to fill the frame, then centre-crop the overflow.
  return [
    resetPts,
    cropRegion,
    `scale=${rw}:${rh}:force_original_aspect_ratio=increase`,
    `crop=${rw}:${rh}`,
  ].join(',');
}

// Slice + crop one scene. Times are in milliseconds relative to raw video t0.
// `pan` (optional) makes the crop window follow keyframes instead of staying put.
export async function cropScene({ rawVideo, startMs, endMs, bbox, output, resolution, fps, fitMode, pan, videoSize }) {
  const start = Math.max(0, startMs) / 1000;
  const duration = Math.max(0.1, (endMs - startMs) / 1000);
  const filter = buildFilter({ bbox, pan, videoSize, resolution, fitMode });

  const args = [
    '-y',
    // `-ss` BEFORE `-i` is input seeking: it resets the decoded frames'
    // timestamps to ~0, so the crop filter's `t` is clip-relative and the
    // pan expressions line up with their (scene-relative) keyframe times.
    // (`-ss` after `-i` keeps the raw video's original timestamps — then
    // `t` is always past every keyframe and the pan window stays pinned.)
    '-ss', start.toFixed(3),
    '-i', rawVideo,
    '-t', duration.toFixed(3),
    '-vf', filter,
    '-r', String(fps),
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-movflags', '+faststart',
    output,
  ];

  await run(FFMPEG, args);
  return output;
}
