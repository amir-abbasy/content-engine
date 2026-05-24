// mm:ss or mm:ss.cs time formatting for transport + rulers.
export function fmtTime(sec, withCs = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  if (!withCs) return base;
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${base}.${String(cs).padStart(2, '0')}`;
}

// Build the global timeline: each scene gets a start offset (t0) + duration.
// Falls back to the authored duration until the real clip duration is known.
export function buildSegments(scenes, durations) {
  let t0 = 0;
  const segments = (scenes || []).map((scene, index) => {
    const dur = (durations && durations[scene.id]) || scene.authoredDurationSec || 0;
    const seg = { scene, index, t0, dur };
    t0 += dur;
    return seg;
  });
  return { segments, total: t0 };
}

// Map a global time to { index, local } within its segment.
export function locate(globalSec, segments) {
  if (!segments.length) return { index: 0, local: 0 };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (globalSec < s.t0 + s.dur || i === segments.length - 1) {
      return { index: i, local: Math.max(0, Math.min(s.dur, globalSec - s.t0)) };
    }
  }
  const last = segments[segments.length - 1];
  return { index: segments.length - 1, local: last.dur };
}
