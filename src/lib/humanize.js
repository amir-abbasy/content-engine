// Building blocks for organic motion + timing: a seeded PRNG, a `sample()`
// helper that resolves "value | [min,max] | {jitter}" into a concrete number,
// named ease curves (used by both the JS cursor driver and the ffmpeg pan
// expression), and a quadratic bezier sampler.
//
// Seed-driven so runs are reproducible — author-time iteration shouldn't be
// noise. Change `record.humanize.seed` to roll a new performance.

// Mulberry32 — tiny, fast, seedable PRNG. Output in [0, 1).
function mulberry32(seedIn) {
  let a = (seedIn >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed = Date.now()) {
  return mulberry32(seed);
}

// Resolve a duration/value spec into a concrete number.
//   number          -> returned, optionally with ±(value*jitter) noise
//   [min, max]      -> uniform sample
//   undefined/null  -> fallback
export function sample(rng, value, { jitter = 0, fallback = 0 } = {}) {
  if (Array.isArray(value) && value.length === 2) {
    const [a, b] = value;
    return a + rng() * (b - a);
  }
  if (typeof value === 'number') {
    if (jitter > 0) return value + (rng() * 2 - 1) * value * jitter;
    return value;
  }
  return fallback;
}

// Eased progress: each function takes a normalized s in [0,1] and returns the
// eased s. Pure JS — used by the cursor driver for velocity shaping.
export const ease = {
  linear:         (s) => s,
  'quad-in':      (s) => s * s,
  'quad-out':     (s) => 1 - (1 - s) * (1 - s),
  'quad-in-out':  (s) => (s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2),
  'cubic-in':     (s) => s * s * s,
  'cubic-out':    (s) => 1 - Math.pow(1 - s, 3),
  'cubic-in-out': (s) => (s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2),
};

// Same curves but emitted as ffmpeg expression strings — used by crop.js to
// ease the camera pan between keyframes (the `t` is an expression too, hence
// the `s` argument is a string, not a number).
export const easeFFmpeg = {
  linear:         (s) => `(${s})`,
  'quad-in':      (s) => `(${s})*(${s})`,
  'quad-out':     (s) => `(1-(1-(${s}))*(1-(${s})))`,
  'quad-in-out':  (s) => `if(lt(${s}\\,0.5)\\,2*(${s})*(${s})\\,1-(2-2*(${s}))*(2-2*(${s}))/2)`,
  'cubic-in':     (s) => `(${s})*(${s})*(${s})`,
  'cubic-out':    (s) => `(1-(1-(${s}))*(1-(${s}))*(1-(${s})))`,
  'cubic-in-out': (s) => `if(lt(${s}\\,0.5)\\,4*(${s})*(${s})*(${s})\\,1-(2-2*(${s}))*(2-2*(${s}))*(2-2*(${s}))/2)`,
};

// Quadratic bezier point at parameter t in [0,1].
export function bezierPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}
