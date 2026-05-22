// Auto-camera — search-menu zoom model.
//
// The camera RESTS at full view. Two kinds of hotspot pull it in (input events
// flagged with `focusZoom`):
//
//   SEARCH  (fill on the "Search nodes…" box): the zoom is tied to the whole
//           right-click → search → pick gesture.
//             • zoom IN starts `delayMs` after the RIGHT-CLICK that opened the
//               menu (i.e. once the search box is focused),
//             • the camera HOLDS zoomed while the user types + reads results,
//             • zoom OUT happens ONLY when the result is clicked.
//
//   INPUT   (fill/click on a node's field): zoom IN `delayMs` after it starts,
//           hold `holdMs`, zoom OUT.
//
// TIMING IS ANCHORED TO REAL EVENTS, NOT THE PLAN. Each keyframe carries a
// `tAnchor: { ref, offsetMs }` — `ref` is the index of the input event that
// triggers the segment and `offsetMs` is the exact delay from when that event
// actually fires. record.js fills in the wall-clock time post-run. This keeps
// the designed zoom-in/out durations exact while pinning the zoom-out to the
// actual result-click (slow typing/cursor travel can't make us pull out early).
//
// No horizontal movement — see record.js `autoZoom.lockX`, which pins the
// crop's X to the capture-region centre. Keyframes are element-anchored.

const round = (x) => Number(x.toFixed(3));
const CURSOR = ['click', 'rightClick', 'dblclick', 'hover', 'fill'];
const isSearchFill = (e) => e.type === 'fill' && /Search nodes/i.test(e.selector || '');

function anchorOf(e) {
  return e.point
    ? { point: e.point }
    : { selector: e.selector, ...(e.position ? { position: e.position } : {}) };
}

export function buildAutoCamera(inputEvents, cfg = {}) {
  const restZoom = cfg.restZoom ?? 1.0;
  const delayMs = cfg.delayMs ?? 1000;
  const zoomMs = cfg.zoomMs ?? 1000;
  const zoomOutMs = cfg.zoomOutMs ?? cfg.zoomMs ?? 1000;
  const holdMs = cfg.holdMs ?? 1000;
  const baseFocus = cfg.focusZoom ?? 2.0;
  const ease = cfg.ease || 'cubic-in-out';

  const idxOf = (e) => inputEvents.indexOf(e);
  const sorted = [...inputEvents].sort((a, b) => (a.at || 0) - (b.at || 0));
  const hotspots = sorted.filter((e) => typeof e.focusZoom === 'number' && (e.selector || e.point));
  if (!hotspots.length) return [];

  const firstCursor = sorted.find((e) => (e.selector || e.point) && CURSOR.includes(e.type)) || hotspots[0];
  // Opening rest keyframe: full view, no anchor (pinned to scene start).
  const kfs = [{ at: 0, ...anchorOf(firstCursor), zoom: restZoom, ease: 'cubic-out', tAnchor: null }];

  for (const h of hotspots) {
    const z = h.focusZoom ?? baseFocus;
    const inA = anchorOf(h);          // zoom target (search box / input field)
    const pane = { selector: '.react-flow__pane' }; // full-view anchor for pull-out

    let inRef;        // input event the zoom-IN is timed from
    let inStartOff;   // ms after that event when the zoom-IN begins
    let outRef;       // input event the zoom-OUT is timed from
    let outStartOff;  // ms after that event when the zoom-OUT begins
    let planInStart;  // approximate plan time (only used to schedule live position resolution)
    let planOutStart;

    if (isSearchFill(h)) {
      const rc = [...sorted].reverse().find((e) => (e.at || 0) <= (h.at || 0) && e.type === 'rightClick');
      const result = sorted.find((e) => (e.at || 0) > (h.at || 0) && (e.type === 'click' || e.type === 'dblclick') && (e.selector || e.point));
      // Zoom IN: delay after the right-click that opened the menu.
      inRef = idxOf(rc ?? h);
      inStartOff = delayMs;
      // Zoom OUT: the moment the result is clicked (offset 0). No result → fall
      // back to a held timeout from the zoom-in.
      outRef = result ? idxOf(result) : inRef;
      outStartOff = result ? 0 : delayMs + zoomMs + holdMs;
      planInStart = (rc ? rc.at || 0 : h.at || 0) + delayMs / 1000;
      planOutStart = result ? (result.at || 0) : planInStart + (zoomMs + holdMs) / 1000;
    } else {
      // Plain input field: zoom in after it starts, hold, zoom out.
      inRef = idxOf(h);
      inStartOff = delayMs;
      outRef = idxOf(h);
      outStartOff = delayMs + zoomMs + holdMs;
      planInStart = (h.at || 0) + delayMs / 1000;
      planOutStart = planInStart + (zoomMs + holdMs) / 1000;
    }

    kfs.push({ at: round(planInStart),                       ...inA,  zoom: restZoom, ease,             tAnchor: { ref: inRef,  offsetMs: inStartOff } });             // about to zoom
    kfs.push({ at: round(planInStart + zoomMs / 1000),       ...inA,  zoom: z,        ease,             tAnchor: { ref: inRef,  offsetMs: inStartOff + zoomMs } });    // ZOOM IN
    kfs.push({ at: round(planOutStart),                      ...inA,  zoom: z,        ease: 'linear',   tAnchor: { ref: outRef, offsetMs: outStartOff } });            // HOLD until result click
    kfs.push({ at: round(planOutStart + zoomOutMs / 1000),   ...pane, zoom: restZoom, ease,             tAnchor: { ref: outRef, offsetMs: outStartOff + zoomOutMs } }); // ZOOM OUT to full view
  }
  return kfs;
}
