// Compose stage — Layer 3 assembly. Turns a recorded, cropped scene clip into a
// narration-synced reel:
//   1. slice the clip into segments (intro, one per node, outro) on the per-node
//      boundaries the recorder captured;
//   2. time-stretch each node segment to its narration window (per-beat speed),
//      so the voice drives the pace;
//   3. concat the sped segments into the paced video;
//   4. mix the voiceover clips in at each beat's start;
//   5. burn word-paced subtitles.
//
// The pan/zoom is already baked into the scene clip by crop.js, so speeding a
// segment just scales its playback uniformly — the camera stays correct.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from '../config.js';
import { pace } from './pacing.js';

function runIn(cwd, bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let err = '';
    const CAP = 64 * 1024; // keep only the tail — a runaway ffmpeg can emit GBs
    p.stderr.on('data', (d) => { err += d; if (err.length > CAP) err = err.slice(-CAP); });
    p.on('error', (e) => reject(new Error(`Failed to start ${bin}: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}\n${err.split('\n').slice(-12).join('\n')}`))));
  });
}

const asTime = (ms) => {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

// Wrap a line to ~`max` chars per row using ASS \N breaks, so long narration
// doesn't run off a 1080-wide frame.
function wrap(text, max = 44) {
  const words = String(text).split(/\s+/);
  const rows = [];
  let row = '';
  for (const w of words) {
    if (row && (row.length + 1 + w.length) > max) { rows.push(row); row = w; }
    else row = row ? `${row} ${w}` : w;
  }
  if (row) rows.push(row);
  return rows.join('\\N');
}

// Resolve each event type to a sound file in `dir` by filename (extension-
// agnostic). Generous aliases so whatever the user drops in just works; a type
// with no matching file is simply silent. `click` is the broadest fallback.
const AUDIO_EXT = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac']);
function resolveSounds(dir) {
  const map = {};
  if (!dir || !fs.existsSync(dir)) return map;
  const files = fs.readdirSync(dir).filter((f) => AUDIO_EXT.has(f.split('.').pop().toLowerCase()));
  const bases = files.map((f) => ({ f, base: f.toLowerCase().replace(/\.[^.]+$/, '') }));
  // Match by alias appearing in the filename (so "mouse-click.mp3" matches
  // "click", "transition-swoosh.mp3" matches "swoosh"). Exact name wins first,
  // then substring; aliases are tried most-specific → most-generic.
  const find = (names) => {
    for (const n of names) { const hit = bases.find((b) => b.base === n); if (hit) return path.join(dir, hit.f); }
    for (const n of names) { const hit = bases.find((b) => b.base.includes(n)); if (hit) return path.join(dir, hit.f); }
    return null;
  };
  map.click = find(['click', 'tap', 'select', 'pop']);
  map.rightClick = find(['rightclick', 'right-click', 'rclick', 'contextmenu', 'menu', 'open', 'click']);
  map.dblclick = find(['dblclick', 'doubleclick', 'click']);
  map.drag = find(['drag', 'connect', 'wire', 'link', 'swoosh', 'whoosh']);
  map.fill = find(['type', 'typing', 'keypress', 'keys', 'fill']);
  map.zoomIn = find(['zoom-in', 'zoomin', 'zoom', 'whoosh', 'woosh', 'swoosh']);
  // Zoom-out is intentionally silent. The transition-swoosh used to fire on every
  // pull-back, which on busy scenes became a constant whoosh-whoosh-whoosh. Add a
  // file named "zoom-out.*" to opt back in for a specific pull-back sound.
  map.zoomOut = find(['zoom-out', 'zoomout']);
  return map;
}

// overlay x:y expression (ffmpeg overlay uses W,H = main, w,h = overlay).
const POS_EXPR = (margin) => ({
  'top-left': `${margin}:${margin}`,
  'top-right': `W-w-${margin}:${margin}`,
  'bottom-left': `${margin}:H-h-${margin}`,
  'bottom-right': `W-w-${margin}:H-h-${margin}`,
  center: `(W-w)/2:(H-h)/2`,
  top: `(W-w)/2:${margin}`,
  bottom: `(W-w)/2:H-h-${margin}`,
  // Centered horizontally, sitting near the bottom but raised 20% of the frame
  // height off the bottom edge (the default placement for emotion gifs).
  'bottom-center': `(W-w)/2:H*0.8-h`,
});

// Resolve GIF markers onto the PACED timeline. Per-beat markers anchor to their
// beat's paced start (matched by actionRef/execId); standalone markers use their
// `at` mapped through the segment speeds. Returns [{ file, startSec, endSec,
// position, scale }] for visible, on-disk gifs only.
function resolveGifOverlays(gifs, { subBeats, totalMs, remapMs }) {
  const totalSec = totalMs / 1000;
  return (gifs || []).map((g) => {
    const beat = g.actionRef ? subBeats.find((b) => b.actionRef === g.actionRef)
      : (g.execId != null ? subBeats.find((b) => b.execId === g.execId) : null);
    const startSec = beat ? (beat.startMs + 120) / 1000
      : Math.max(0, Math.min(g.at != null ? remapMs(g.at) / 1000 : 0, totalSec - 0.4));
    const endSec = Math.min(totalSec, startSec + (g.durationSec || 2));
    return { file: g.file, startSec, endSec, position: g.position || 'bottom-center', scale: g.scale || 0.6 };
  }).filter((o) => o.file && fs.existsSync(o.file) && o.endSec > o.startSec);
}

function buildAss({ res, beats }) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${res.width}`, `PlayResY: ${res.height}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Tiny, simple white reference caption (no box, no bold, thin outline for
    // legibility) — the main on-screen text + effects are added separately.
    `Style: Default,Arial,26,&H00FFFFFF,&H80000000,&H00000000,0,1,1,0,2,80,80,120,1`, '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = beats.map((b) =>
    `Dialogue: 0,${asTime(b.startMs)},${asTime(b.startMs + b.windowMs)},Default,,0,0,0,,${wrap(b.line)}`);
  return [...head, ...events].join('\n');
}

// segments: [{ start, dur, speed }] in the source clip's seconds. Slice + speed
// each into the work dir, return the segment file names (relative to workDir).
async function sliceSegments(workDir, sceneClip, segments, fps) {
  const files = [];
  for (let i = 0; i < segments.length; i++) {
    const { start, dur, speed } = segments[i];
    const name = `seg_${String(i).padStart(2, '0')}.mp4`;
    await runIn(workDir, FFMPEG, [
      '-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', sceneClip,
      '-vf', `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}`,
      '-an', '-r', String(fps), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      name,
    ]);
    files.push(name);
  }
  return files;
}

// Build the planned beats + segment list from recorder boundaries + VO durations.
function planSegments({ addBoundaries, actionsEndSec, clipDurationSec, voBeats, introSpeed, outroSpeed, maxSpeed }) {
  const byId = new Map(addBoundaries.map((b) => [b.execId, b.clipSec]));
  // Node action windows (source seconds): each add -> next add (last -> Execute).
  const nodeSegs = voBeats.map((vb, i) => {
    const start = byId.get(vb.execId);
    const next = voBeats[i + 1] ? byId.get(voBeats[i + 1].execId) : actionsEndSec;
    return { start, end: next, vb };
  });
  // Pace: per-beat speed fits each action window to its narration.
  const paced = pace(nodeSegs.map((s) => ({ ref: s.vb.execId, label: s.vb.label, actionMs: (s.end - s.start) * 1000, narrationMs: s.vb.narrationMs })), { maxSpeed });

  const segments = [];
  const subBeats = [];
  const segTable = []; // for clip-time -> paced-time remapping (SFX cues)
  let off = 0; // paced timeline cursor (ms)
  const pushSeg = (start, dur, speed) => {
    segments.push({ start, dur, speed });
    segTable.push({ clipStart: start, clipEnd: start + dur, pacedStartMs: off, speed });
    off += (dur / speed) * 1000;
  };
  // intro: clip start -> first node's action.
  const introDur = nodeSegs[0].start;
  if (introDur > 0.05) pushSeg(0, introDur, introSpeed);
  // per node, sped to its narration window.
  nodeSegs.forEach((s, i) => {
    const p = paced.beats[i];
    const audioStartMs = off;
    pushSeg(s.start, s.end - s.start, p.speed);
    // `actionRef`/`execId` carried so GIF overlays can anchor to a beat's PACED
    // start time (same anchoring as subtitles + voiceover).
    subBeats.push({ startMs: audioStartMs, windowMs: p.windowMs, line: s.vb.line, audioPath: s.vb.audioPath, audioStartMs, actionRef: s.vb.actionRef || null, execId: s.vb.execId });
  });
  // outro: after the last action (Execute + result reveal + hold) to clip end.
  const outroStart = actionsEndSec;
  const outroDur = Math.max(0, clipDurationSec - outroStart);
  if (outroDur > 0.05) pushSeg(outroStart, outroDur, outroSpeed);

  // Map a clip-time (s) to its paced-time (ms) through the segment speeds.
  const remapMs = (clipSec) => {
    for (const s of segTable) {
      if (clipSec < s.clipStart) return s.pacedStartMs;
      if (clipSec <= s.clipEnd) return s.pacedStartMs + ((clipSec - s.clipStart) / s.speed) * 1000;
    }
    return off;
  };

  return { segments, subBeats, totalMs: off, remapMs };
}

async function concat(workDir, files, outName) {
  const listFile = path.join(workDir, 'concat.txt');
  fs.writeFileSync(listFile, files.map((f) => `file '${f}'`).join('\n'));
  await runIn(workDir, FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', outName]);
}

// Mix a set of audio cues into one track of `totalMs`. Each cue is
// { audioPath, atMs, gain } — placed at `atMs`, scaled by `gain` (VO at 1.0,
// SFX quieter so they sit under the narration). Different files can repeat
// across cues (e.g. the same click sound at every click).
async function buildAudioTrack(workDir, cues, totalMs, outName) {
  const valid = cues.filter((c) => c.audioPath && fs.existsSync(c.audioPath) && Number.isFinite(c.atMs));
  if (!valid.length) return null;
  const args = ['-y'];
  valid.forEach((c) => args.push('-i', c.audioPath));
  // Normalise every clip to a common stereo 48 kHz layout BEFORE delaying, so
  // amix gets uniform streams; aresample=async=1 after the mix fills gaps and
  // forces MONOTONIC timestamps. Output is PCM WAV — a raw .aac (adts) muxer
  // chokes on the delayed/padded graph and spams non-monotonic-dts warnings
  // forever (a multi-GB stderr runaway); WAV is immune and the final mux
  // encodes to AAC once.
  const parts = valid.map((c, i) =>
    `[${i}]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000,volume=${(c.gain ?? 1).toFixed(2)},adelay=${Math.max(0, Math.round(c.atMs))}:all=1[a${i}]`);
  const mix = valid.map((_, i) => `[a${i}]`).join('');
  const filter = `${parts.join(';')};${mix}amix=inputs=${valid.length}:normalize=0,aresample=async=1:first_pts=0,apad[a]`;
  args.push('-filter_complex', filter, '-map', '[a]', '-t', (totalMs / 1000).toFixed(3), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', outName);
  await runIn(workDir, FFMPEG, args);
  return outName;
}

export async function composeReel(cfg) {
  const { sceneClip, addBoundaries, actionsEndSec, clipDurationSec, voBeats, resolution, fps, outPath,
    sfxCues = [], soundsDir = null, sfxGain = 0.55, gifs = [], gifMargin = 40,
    introSpeed = 2.0, outroSpeed = 1.25, maxSpeed = 3.0 } = cfg;
  const workDir = fs.mkdtempSync(path.join(path.dirname(outPath), 'compose-'));
  try {
    const { segments, subBeats, totalMs, remapMs } = planSegments({ addBoundaries, actionsEndSec, clipDurationSec, voBeats, introSpeed, outroSpeed, maxSpeed });

    const segFiles = await sliceSegments(workDir, path.resolve(sceneClip), segments, fps);
    await concat(workDir, segFiles, 'paced.mp4');

    // Audio = voiceover (full volume) + sound effects (quieter), each placed on
    // the PACED timeline: VO at its beat start, SFX at its event time remapped
    // through the per-beat speed so a sped click still lands on the visible click.
    const sounds = resolveSounds(soundsDir);
    const voCues = subBeats.filter((b) => b.audioPath).map((b) => ({ audioPath: b.audioPath, atMs: b.audioStartMs, gain: 1.0 }));
    const sfx = sfxCues
      .map((c) => ({ audioPath: sounds[c.type], atMs: remapMs(c.clipSec), gain: sfxGain }))
      .filter((c) => c.audioPath);
    const audioName = await buildAudioTrack(workDir, [...voCues, ...sfx], totalMs, 'mix.wav');

    fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss({ res: resolution, beats: subBeats }));

    // GIF/sticker overlays placed on the paced timeline (corner reactions).
    const overlays = resolveGifOverlays(gifs, { subBeats, totalMs, remapMs });

    // Final: burn subtitles + composite gif overlays, mux audio. Run from workDir
    // so the subtitles filter takes a bare filename (drive-colon escaping is a
    // minefield). With overlays we build one filter_complex (subtitles → chained
    // overlays); without, the simple -vf subtitles path is kept.
    const finalArgs = ['-y', '-i', 'paced.mp4'];
    if (audioName) finalArgs.push('-i', audioName);
    const gifInStart = 1 + (audioName ? 1 : 0); // input index of the first gif
    overlays.forEach((o) => finalArgs.push('-ignore_loop', '0', '-i', path.resolve(o.file)));

    if (overlays.length) {
      const posMap = POS_EXPR(gifMargin);
      let fc = `[0:v]subtitles=subs.ass[v0]`;
      let cur = 'v0';
      overlays.forEach((o, k) => {
        const px = Math.round(resolution.width * o.scale);
        const xy = posMap[o.position] || posMap['top-right'];
        const nxt = `v${k + 1}`;
        fc += `;[${gifInStart + k}:v]scale=${px}:-1[g${k}]`;
        fc += `;[${cur}][g${k}]overlay=${xy}:enable='between(t,${o.startSec.toFixed(2)},${o.endSec.toFixed(2)})':eof_action=pass[${nxt}]`;
        cur = nxt;
      });
      finalArgs.push('-filter_complex', fc, '-map', `[${cur}]`);
      if (audioName) finalArgs.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      finalArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-t', (totalMs / 1000).toFixed(3), '-movflags', '+faststart', path.resolve(outPath));
    } else {
      finalArgs.push('-vf', 'subtitles=subs.ass', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
      // Universally-playable audio + web/social compatibility (stereo 48 kHz AAC,
      // +faststart so players can start before the whole file loads).
      if (audioName) finalArgs.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest');
      finalArgs.push('-movflags', '+faststart', path.resolve(outPath));
    }
    await runIn(workDir, FFMPEG, finalArgs);

    return { outPath, totalMs, segments: segments.length, voiced: !!voCues.length, sfx: sfx.length, gifs: overlays.length, subBeats };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Compose a SIMPLE single-segment scene (no per-node beats) into a finalized
// clip — used for the chart-reveal outro. Uniform speed (fit to the VO line if
// one is given, else a gentle tighten), SFX remapped through that speed, an
// optional VO line + caption, and always a stereo-48k audio track (silent if
// nothing to play) so it concatenates cleanly with the main reel.
export async function composeSimple(cfg) {
  const { sceneClip, clipDurationSec, sfxCues = [], soundsDir = null, sfxGain = 0.55,
    voLine = null, voAudioPath = null, narrationMs = 0, resolution, fps, outPath, speed: speedIn } = cfg;
  const workDir = fs.mkdtempSync(path.join(path.dirname(outPath), 'compose-'));
  try {
    const dur = Math.max(0.1, clipDurationSec);
    let speed = speedIn || 1.25;
    if (narrationMs > 0) speed = Math.min(2.5, Math.max(1, (dur * 1000) / narrationMs));
    const pacedMs = (dur / speed) * 1000;

    const segFiles = await sliceSegments(workDir, path.resolve(sceneClip), [{ start: 0, dur, speed }], fps);
    await concat(workDir, segFiles, 'paced.mp4');

    const sounds = resolveSounds(soundsDir);
    const remapMs = (clipSec) => (clipSec / speed) * 1000;
    const cues = [];
    if (voAudioPath) cues.push({ audioPath: voAudioPath, atMs: 300, gain: 1.0 });
    for (const c of sfxCues) { const f = sounds[c.type]; if (f) cues.push({ audioPath: f, atMs: remapMs(c.clipSec), gain: sfxGain }); }
    const audioName = await buildAudioTrack(workDir, cues, pacedMs, 'mix.wav');

    const subBeats = voLine ? [{ startMs: 300, windowMs: Math.max(narrationMs || 0, pacedMs - 300), line: voLine }] : [];
    fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss({ res: resolution, beats: subBeats }));

    const finalArgs = ['-y', '-i', 'paced.mp4'];
    if (audioName) finalArgs.push('-i', audioName);
    else finalArgs.push('-f', 'lavfi', '-t', (pacedMs / 1000).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
    finalArgs.push('-vf', 'subtitles=subs.ass', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
    finalArgs.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest');
    finalArgs.push('-movflags', '+faststart', path.resolve(outPath));
    await runIn(workDir, FFMPEG, finalArgs);
    return { outPath, durationMs: pacedMs, voiced: !!voAudioPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Concatenate finalized clips (identical codec params) into one file via
// stream-copy — every clip here is encoded with the same settings.
export async function concatClips(files, outPath) {
  const dir = path.dirname(outPath);
  const listName = `_concat_${Date.now()}.txt`;
  fs.writeFileSync(path.join(dir, listName), files.map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`).join('\n'));
  try {
    await runIn(dir, FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', '-movflags', '+faststart', path.resolve(outPath)]);
  } finally {
    fs.rmSync(path.join(dir, listName), { force: true });
  }
}
