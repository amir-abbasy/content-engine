// Humanized cursor: instead of Playwright's teleport-then-click, the cursor
// travels along a quadratic bezier from its current position to the target.
// The control point is offset perpendicular to the chord (random side, random
// magnitude scaled by `curvature`) so the path arcs rather than slides
// straight. Velocity along the path is eased (cubic-in-out) so the cursor
// accelerates from rest and settles at the end.
//
// Two flourishes that sell "human":
//   - overshoot: the cursor aims slightly past the target along the chord,
//     then settles back over a couple frames — like a hand correcting its aim
//   - hesitation: a short pause after arrival, before the click fires — like
//     a moment to verify the target
//
// State: the driver remembers (cx, cy) so successive moves chain naturally.

import { bezierPoint, ease, sample } from './humanize.js';

const STEP_MIN = 12;
const STEP_MAX = 28;
const STEP_MIN_INTERVAL_MS = 8;

export function createCursorDriver(page, rng, opts = {}) {
  const movement   = opts.movement   ?? 'human';
  const duration   = opts.duration   ?? [380, 720];
  const overshoot  = opts.overshoot  ?? 0.12;
  const hesitation = opts.hesitation ?? [70, 180];
  const curvature  = opts.curvature  ?? 0.4;

  // Bootstrap the cursor offscreen so the first move animates from somewhere
  // sensible (top-left of the viewport).
  let cx = 0;
  let cy = 0;

  async function moveTo(tx, ty) {
    if (movement !== 'human') {
      await page.mouse.move(tx, ty);
      cx = tx; cy = ty;
      return;
    }
    const dx = tx - cx;
    const dy = ty - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) { cx = tx; cy = ty; return; }

    // Quadratic bezier: control point offset perpendicular to the chord, on
    // a random side, with magnitude scaling with both distance and curvature.
    const perpX = -dy / dist;
    const perpY =  dx / dist;
    const side = rng() > 0.5 ? 1 : -1;
    const bend = side * (0.5 + rng() * 0.5) * curvature * Math.min(dist, 600);
    const mid = { x: cx + dx / 2 + perpX * bend, y: cy + dy / 2 + perpY * bend };
    const p0 = { x: cx, y: cy };
    const p2 = { x: tx, y: ty };

    // Optional overshoot point: 0–overshoot * 24px past target along chord.
    const overMag = overshoot > 0 ? overshoot * (0.7 + rng() * 0.6) * 24 : 0;
    const overPt = overMag > 0
      ? { x: tx + (dx / dist) * overMag, y: ty + (dy / dist) * overMag }
      : null;

    const totalMs = sample(rng, duration);
    const steps = Math.max(STEP_MIN, Math.min(STEP_MAX, Math.round(dist / 40) + STEP_MIN));
    const stepMs = Math.max(STEP_MIN_INTERVAL_MS, totalMs / steps);
    const easeFn = ease['cubic-in-out'];

    for (let i = 1; i <= steps; i++) {
      const s = easeFn(i / steps);
      const pt = bezierPoint(p0, mid, overPt || p2, s);
      await page.mouse.move(pt.x, pt.y);
      await page.waitForTimeout(stepMs);
    }
    if (overPt) {
      // Settle back to the true target in a few quick steps — visible "tiny
      // correction" at the end of the gesture.
      const settleSteps = 4;
      const fromX = overPt.x;
      const fromY = overPt.y;
      for (let i = 1; i <= settleSteps; i++) {
        const s = i / settleSteps;
        await page.mouse.move(fromX + (tx - fromX) * s, fromY + (ty - fromY) * s);
        await page.waitForTimeout(18);
      }
    }
    cx = tx; cy = ty;
  }

  async function hesitate() {
    const ms = Math.round(sample(rng, hesitation, { fallback: 0 }));
    if (ms > 0) await page.waitForTimeout(ms);
  }

  return {
    moveTo,
    hesitate,
    get pos() { return { x: cx, y: cy }; },
  };
}
