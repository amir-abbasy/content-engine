// Pacing solver — Layer 2's timing brain. NARRATION-DRIVEN: the spoken line is
// the master clock; the visual action is fit to it via per-beat time-stretch.
//
// Each beat carries:
//   actionMs    — the intrinsic time the node's on-camera actions need (add +
//                 settings + wiring), as recorded at speed 1.
//   narrationMs — the spoken line's measured duration (from the TTS adapter).
//
// Strategy = per-beat variable speed. An over-long action is SPED UP toward its
// narration window so the voice drives the pace:
//   • speed = clamp(actionMs / narrationMs, 1, maxSpeed). Never slow-mo (>=1),
//     never beyond maxSpeed (past that, typing/drag look frantic).
//   • The compositor then plays that node's recorded segment at `speed`.
//   • If the cap still leaves the action longer than the line, the beat keeps a
//     short tail (action-bound, flagged). If the line is longer than the sped
//     action, the camera HOLDS the remainder so the picture waits for the voice.
//
// Pure + deterministic: same beats in, same timeline out. No I/O, no app.

const r = (x) => Math.round(x);
const r2 = (x) => Number(x.toFixed(2));

export function pace(beats, { breathMs = 200, maxSpeed = 3.0 } = {}) {
  let cursor = 0;
  const out = [];
  for (const b of beats) {
    const actionMs = Math.max(0, b.actionMs || 0);
    const narrationMs = Math.max(0, b.narrationMs || 0);
    const speed = actionMs > narrationMs && narrationMs > 0
      ? Math.min(maxSpeed, actionMs / narrationMs)
      : 1;
    const effActionMs = speed > 0 ? actionMs / speed : actionMs;
    const windowMs = Math.max(effActionMs, narrationMs);
    const holdMs = Math.max(0, windowMs - effActionMs);
    const bound = narrationMs >= effActionMs ? 'narration' : 'action';
    out.push({
      ref: b.ref,
      label: b.label || b.ref,
      startMs: r(cursor),
      narrationStartMs: r(cursor),                 // voice leads the beat
      narrationEndMs: r(cursor + narrationMs),
      actionMs: r(actionMs),
      narrationMs: r(narrationMs),
      speed: r2(speed),
      effActionMs: r(effActionMs),
      windowMs: r(windowMs),
      holdMs: r(holdMs),
      bound,
    });
    cursor += windowMs + breathMs;
  }
  return { totalMs: r(Math.max(0, cursor - breathMs)), beats: out };
}
