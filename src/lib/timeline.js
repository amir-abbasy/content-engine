// Timeline scheduler — runs a flat array of timed events on an absolute
// scene-relative axis. Each event has `at` (seconds from t=0). The scheduler
// sorts by `at`, then for each event: wait until its `at` is reached (relative
// to the wall-clock anchor captured at start), then dispatch it.
//
// Drift handling: if dispatching event N takes longer than its slot, event
// N+1's gap will be negative — we don't wait, we fire immediately. Events
// compress in time rather than shift. Author with realistic spacing.

import { log } from './log.js';

export async function runEvents(events, page, dispatch, { label = 'timeline' } = {}) {
  if (!events || events.length === 0) return Date.now();
  const sorted = [...events].sort((a, b) => (a.at || 0) - (b.at || 0));
  const startWall = Date.now();

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const targetMs = (ev.at || 0) * 1000;
    const elapsed = Date.now() - startWall;
    const gap = targetMs - elapsed;
    if (gap > 0) await page.waitForTimeout(gap);

    const tNow = ((Date.now() - startWall) / 1000).toFixed(2);
    const tag = ev._track ? `[${ev._track}] ` : '';
    const detail =
      ev.type ? ev.type :
      ev.point ? `cam-point` :
      ev.selector ? `cam→${ev.selector}` : '?';
    log.info(`  ${label} t=${tNow}s ${tag}${detail}`);

    try {
      await dispatch(ev);
    } catch (e) {
      log.warn(`  event @${(ev.at || 0).toFixed(2)}s failed: ${e.message}`);
    }
  }

  return Date.now() - startWall;
}
