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

// The node a selector acts on, e.g. `.react-flow__node[data-id="2"] input…`
// -> `.react-flow__node[data-id="2"]`. Falls back to the pane (full view) when
// the selector isn't node-scoped.
function nodeSelOf(selector) {
  const m = /\.react-flow__node\[data-id="(\d+)"\]/.exec(selector || '');
  return m ? `.react-flow__node[data-id="${m[1]}"]` : '.react-flow__pane';
}

function anchorOf(e) {
  // `focusSelector` lets a hotspot frame a DIFFERENT element than the one it
  // acts on — e.g. click a node to open its colour popover, but frame the
  // [role="dialog"], not the node.
  if (e.focusSelector) return { selector: e.focusSelector };
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
  const panMs = cfg.panMs ?? 300; // fast inter-hotspot glide — the camera HOLDS
  // on the current node, then snaps to the next over this short window (instead
  // of drifting slowly across the whole gap).
  const baseFocus = cfg.focusZoom ?? 2.0;
  const ease = cfg.ease || 'cubic-in-out';

  const idxOf = (e) => inputEvents.indexOf(e);
  const sorted = [...inputEvents].sort((a, b) => (a.at || 0) - (b.at || 0));
  const hotspots = sorted.filter((e) => typeof e.focusZoom === 'number' && (e.selector || e.point));
  if (!hotspots.length) return [];

  const firstCursor = sorted.find((e) => (e.selector || e.point) && CURSOR.includes(e.type)) || hotspots[0];
  // Opening rest keyframe: full view, no anchor (pinned to scene start).
  const kfs = [{ at: 0, ...anchorOf(firstCursor), zoom: restZoom, ease: 'cubic-out', tAnchor: null }];
  let prevRestSel = anchorOf(firstCursor).selector || '.react-flow__pane';

  hotspots.forEach((h, hi) => {
    const z = h.focusZoom ?? baseFocus;
    // All zoomed keyframes for this hotspot share one resolved position so the
    // camera is pixel-LOCKED through the whole close-up — record.js resolves the
    // point once per group and reuses it (no drift while typing/choosing).
    const fg = `hs${hi}`;
    const inA = anchorOf(h);          // zoom target (search box / input field)

    let inRef;        // input event the zoom-IN is timed from
    let inStartOff;   // ms after that event when the zoom-IN begins
    let outRef;       // input event the zoom-OUT is timed from
    let outStartOff;  // ms after that event when the zoom-OUT begins
    let planInStart;  // approximate plan time (only used to schedule live position resolution)
    let planOutStart;
    // Where the camera RESTS after this hotspot. The pull-out should CENTRE on
    // the node that was just added/edited (so it's visible) — NOT the pane
    // centre, which only ever shows the middle slice and hides edge nodes.
    let restSel = nodeSelOf(h.selector);

    if (isSearchFill(h)) {
      const rc = [...sorted].reverse().find((e) => (e.at || 0) <= (h.at || 0) && e.type === 'rightClick');
      const result = sorted.find((e) => (e.at || 0) > (h.at || 0) && (e.type === 'click' || e.type === 'dblclick') && (e.selector || e.point));
      // The picked node lands in the flow at the injectFlow right AFTER the
      // result click — that's the cue to pull out (not the click itself, so the
      // viewer first sees the result clicked + the node appear at full zoom).
      const added = result ? sorted.find((e) => (e.at || 0) > (result.at || 0) && e.type === 'injectFlow') : null;
      const outAnchor = added ?? result;
      // Zoom IN: delay after the right-click that opened the menu.
      inRef = idxOf(rc ?? h);
      inStartOff = delayMs;
      // Zoom OUT: the moment the node is added (offset 0). No anchor → fall back
      // to a held timeout from the zoom-in.
      outRef = outAnchor ? idxOf(outAnchor) : inRef;
      outStartOff = outAnchor ? 0 : delayMs + zoomMs + holdMs;
      planInStart = (rc ? rc.at || 0 : h.at || 0) + delayMs / 1000;
      planOutStart = outAnchor ? (outAnchor.at || 0) : planInStart + (zoomMs + holdMs) / 1000;
      // Rest on the freshly-added node (its id == the injectFlow's nodeCount).
      if (added && added.nodeCount != null) restSel = `.react-flow__node[data-id="${added.nodeCount}"]`;
    } else {
      // Plain hotspot (value input OR a click that opens a dialog). Zoom in
      // after it starts. If it opens something the user then COMMITS in — a
      // colour swatch inside a [role="dialog"], before the next hotspot — hold
      // until that commit, then pull out. Otherwise hold a fixed beat.
      inRef = idxOf(h);
      inStartOff = delayMs;
      planInStart = (h.at || 0) + delayMs / 1000;
      const nextHs = hotspots[hi + 1];
      const scopeEnd = nextHs ? (nextHs.at || 0) : Infinity;
      const commit = sorted.find((e) =>
        (e.at || 0) > (h.at || 0) && (e.at || 0) < scopeEnd
        && e.type === 'click' && /dialog/i.test(e.selector || ''));
      if (commit) {
        outRef = idxOf(commit);
        outStartOff = 0;
        planOutStart = commit.at || 0;
      } else {
        outRef = idxOf(h);
        outStartOff = delayMs + zoomMs + holdMs;
        planOutStart = planInStart + (zoomMs + holdMs) / 1000;
      }
    }

    // Hold on the PREVIOUS node, then snap over `panMs` to this hotspot — the
    // pan is fast no matter how long the gap is (the camera just waits longer
    // on the previous node). Anchored to the same event as the zoom-in.
    kfs.push({ at: round(planInStart - panMs / 1000),      selector: prevRestSel, zoom: restZoom, ease: 'linear',  seg: hi, tAnchor: { ref: inRef,  offsetMs: Math.max(0, inStartOff - panMs) } }); // hold on prev node
    kfs.push({ at: round(planInStart),                     ...inA,  zoom: restZoom, ease: 'cubic-out',   focusGroup: fg, seg: hi, tAnchor: { ref: inRef,  offsetMs: inStartOff } });             // fast-glide arrived, about to zoom
    kfs.push({ at: round(planInStart + zoomMs / 1000),     ...inA,  zoom: z,        ease,               focusGroup: fg, seg: hi, tAnchor: { ref: inRef,  offsetMs: inStartOff + zoomMs } });    // ZOOM IN
    kfs.push({ at: round(planOutStart),                    ...inA,  zoom: z,        ease: 'linear',     focusGroup: fg, seg: hi, tAnchor: { ref: outRef, offsetMs: outStartOff } });            // HOLD — locked still
    kfs.push({ at: round(planOutStart + zoomOutMs / 1000), selector: restSel, zoom: restZoom, ease,                   seg: hi, tAnchor: { ref: outRef, offsetMs: outStartOff + zoomOutMs } }); // ZOOM OUT, centred on the node
    prevRestSel = restSel; // next hotspot glides FROM this node
  });
  return kfs;
}
