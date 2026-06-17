// Auto-camera — ONE zoom SESSION per node.
//
// The camera RESTS at full view and pulls in on HOTSPOTS (input events flagged
// with `focusZoom`). Hotspots that share a `focusSession` (set by the generator
// to a node id) are ONE session: the camera zooms in ONCE, GLIDES between the
// inputs that session touches (search box → each field → colour), holds while
// each is edited, then zooms out ONCE — instead of a jarring zoom-in/out per
// field. A node with several inputs (e.g. MACD fast/slow/signal) therefore gets
// a single, smooth close-up that travels across its inputs.
//
//   SEARCH  (first item, fill on the "Search nodes…" box): zoom IN starts
//           `delayMs` after the right-click that opened the menu.
//   FIELDS  (later items, a node's value/colour edits): the camera glides to
//           each as it's edited, staying zoomed.
//   OUT     after the LAST item's edit. A lone search hotspot (node with no
//           settings) zooms out on the result click; a drag frames both ends.
//
// TIMING IS ANCHORED TO REAL EVENTS, NOT THE PLAN. Each keyframe carries a
// `tAnchor: { ref, offsetMs }` — `ref` is the index of the input event it's
// timed from, `offsetMs` the exact delay. record.js fills in the wall-clock time
// post-run so designed durations stay exact while triggers track reality.

const round = (x) => Number(x.toFixed(3));
const CURSOR = ['click', 'rightClick', 'dblclick', 'hover', 'fill'];
const isSearchFill = (e) => e.type === 'fill' && /Search nodes/i.test(e.selector || '');

// The node a selector acts on, e.g. `.react-flow__node[data-id="2"] input…`
// -> `.react-flow__node[data-id="2"]`. Falls back to the pane (full view).
function nodeSelOf(selector) {
  const m = /\.react-flow__node\[data-id="(\d+)"\]/.exec(selector || '');
  return m ? `.react-flow__node[data-id="${m[1]}"]` : '.react-flow__pane';
}

// The node a hotspot belongs to (its own selector, or its focusSelector's node).
function nodeOf(e) {
  const a = nodeSelOf(e.selector);
  if (a !== '.react-flow__pane') return a;
  const m = /\.react-flow__node\[data-id="(\d+)"\]/.exec(e.focusSelector || '');
  return m ? `.react-flow__node[data-id="${m[1]}"]` : '.react-flow__pane';
}

function anchorOf(e) {
  // `focusSelector` lets a hotspot frame a DIFFERENT element than the one it
  // acts on (e.g. click a node's swatch but frame the colour [role="dialog"]).
  // `nth` disambiguates repeated selectors (e.g. MACD's three int fields).
  if (e.focusSelector) return { selector: e.focusSelector };
  return e.point
    ? { point: e.point }
    : { selector: e.selector, ...(e.position ? { position: e.position } : {}), ...(e.nth !== undefined ? { nth: e.nth } : {}) };
}

export function buildAutoCamera(inputEvents, cfg = {}) {
  const restZoom = cfg.restZoom ?? 1.0;
  const delayMs = cfg.delayMs ?? 1000;
  const zoomMs = cfg.zoomMs ?? 1000;
  const zoomOutMs = cfg.zoomOutMs ?? cfg.zoomMs ?? 1000;
  const holdMs = cfg.holdMs ?? 1000;
  const panMs = cfg.panMs ?? 300; // fast glide between hotspots/inputs
  const baseFocus = cfg.focusZoom ?? 2.0;
  const ease = cfg.ease || 'cubic-in-out';

  const idxOf = (e) => inputEvents.indexOf(e);
  const sorted = [...inputEvents].sort((a, b) => (a.at || 0) - (b.at || 0));
  const hotspots = sorted.filter((e) => typeof e.focusZoom === 'number' && (e.selector || e.point));
  if (!hotspots.length) return [];

  // Group consecutive hotspots sharing a `focusSession` into one zoom session.
  const sessions = [];
  for (const h of hotspots) {
    const prev = sessions[sessions.length - 1];
    if (prev && h.focusSession != null && prev.key === h.focusSession) prev.items.push(h);
    else sessions.push({ key: h.focusSession, items: [h] });
  }

  const firstCursor = sorted.find((e) => (e.selector || e.point) && CURSOR.includes(e.type)) || hotspots[0];
  // Opening rest keyframe: full view, pinned to scene start.
  const kfs = [{ at: 0, ...anchorOf(firstCursor), zoom: restZoom, ease: 'cubic-out', tAnchor: null }];
  let prevRestSel = anchorOf(firstCursor).selector || '.react-flow__pane';

  sessions.forEach((session, si) => {
    const items = session.items;
    const first = items[0];
    const last = items[items.length - 1];
    const z = first.focusZoom ?? baseFocus;
    const fg = `s${si}`;
    const isDrag = first.type === 'drag';
    // This session owns events only up to the NEXT session's first hotspot — so
    // searches for the result-click / colour-commit can't grab a later node's.
    const scopeEnd = sessions[si + 1] ? (sessions[si + 1].items[0].at || 0) : Infinity;

    // Node the camera rests on once it pulls back.
    let restSel = '.react-flow__pane';
    for (const it of items) { const n = nodeOf(it); if (n !== '.react-flow__pane') { restSel = n; break; } }

    // ── zoom-IN timing — from the FIRST item.
    let inRef, inStartOff, planInStart;
    if (isSearchFill(first)) {
      const rc = [...sorted].reverse().find((e) => (e.at || 0) <= (first.at || 0) && e.type === 'rightClick');
      inRef = idxOf(rc ?? first); inStartOff = delayMs;
      planInStart = (rc ? rc.at || 0 : first.at || 0) + delayMs / 1000;
    } else {
      inRef = idxOf(first); inStartOff = delayMs;
      planInStart = (first.at || 0) + delayMs / 1000;
    }

    // ── zoom-OUT timing — from the LAST item.
    let outRef, outStartOff, planOutStart;
    if (isSearchFill(last)) {
      // Lone search (node with no settings): pull out when the result is clicked.
      const result = sorted.find((e) => (e.at || 0) > (last.at || 0) && (e.type === 'click' || e.type === 'dblclick') && (e.selector || e.point));
      outRef = result ? idxOf(result) : idxOf(last);
      outStartOff = result ? holdMs : delayMs + zoomMs + holdMs;
      planOutStart = result ? (result.at || 0) + holdMs / 1000 : planInStart + (zoomMs + holdMs) / 1000;
    } else {
      // A colour edit commits in a [role="dialog"]; hold until that click, else
      // a fixed beat after the last field. The commit search is BOUNDED to this
      // session (scopeEnd) — without it a drag with no dialog grabbed a LATER
      // node's colour pick, so the drag stayed zoomed for seconds and overlapped
      // the next session (the shaky pull-out). The plain pull-out (a drag) holds
      // delayMs+zoomMs+holdMs after the action — i.e. AFTER the zoom-in finishes,
      // so the hold/zoom-out keyframes never land before the zoom-in completes.
      const commit = sorted.find((e) => (e.at || 0) > (last.at || 0) && (e.at || 0) < scopeEnd && e.type === 'click' && /dialog/i.test(e.selector || ''));
      if (commit) { outRef = idxOf(commit); outStartOff = holdMs; planOutStart = (commit.at || 0) + holdMs / 1000; }
      else { outRef = idxOf(last); outStartOff = delayMs + zoomMs + holdMs; planOutStart = (last.at || 0) + (delayMs + zoomMs + holdMs) / 1000; }
    }

    const inA = isDrag ? { framePair: { a: first.selector, b: first.toSelector }, focusSelector: first.focusSelector } : anchorOf(first);
    const outA = isDrag ? inA : { selector: restSel };
    const fgB = `${fg}b`; // second locked frame (the node, for the settings phase)

    // 1) hold on previous node, 2) fast-glide arrive on the first target, 3) zoom IN.
    // The camera only MOVES here (before any typing) and zooms in over zoomMs.
    kfs.push({ at: round(planInStart - panMs / 1000), selector: prevRestSel, zoom: restZoom, ease: 'linear', seg: si, tAnchor: { ref: inRef, offsetMs: Math.max(0, inStartOff - panMs) } });
    kfs.push({ at: round(planInStart), ...inA, zoom: restZoom, ease: 'cubic-out', focusGroup: fg, seg: si, tAnchor: { ref: inRef, offsetMs: inStartOff } });
    kfs.push({ at: round(planInStart + zoomMs / 1000), ...inA, zoom: z, ease, focusGroup: fg, seg: si, tAnchor: { ref: inRef, offsetMs: inStartOff + zoomMs } });

    if (isSearchFill(first)) {
      // The camera is now LOCKED on the search box. Hold it dead-still until the
      // result is picked — no pan/zoom while the node NAME is being typed, so it
      // stays readable. Then glide to the node and hold still through settings.
      const result = sorted.find((e) => (e.at || 0) > (first.at || 0) && (e.at || 0) < scopeEnd && (e.type === 'click' || e.type === 'dblclick') && (e.selector || e.point));
      const resRef = result ? idxOf(result) : inRef;
      const resOff = result ? holdMs : inStartOff + zoomMs + holdMs;
      const planRes = result ? (result.at || 0) + holdMs / 1000 : planInStart + (zoomMs + holdMs) / 1000;
      kfs.push({ at: round(planRes), ...inA, zoom: z, ease: 'linear', focusGroup: fg, seg: si, tAnchor: { ref: resRef, offsetMs: resOff } }); // HOLD on search box (typing the name)

      const configs = items.slice(1);
      if (configs.length) {
        // Frame the NODE for its settings (its int fields) — or the colour
        // [role="dialog"] if the edit is a colour. Held still while typing.
        // The dialog only exists between the swatch-click and the colour-pick;
        // a camera keyframe timed just outside that window can't resolve it, so
        // it would be SKIPPED live and the camera would slowly drift from the
        // search box to the node instead of holding+snapping out. `fallbackSelector`
        // keeps the keyframe alive on the node in that case.
        const cfgFrame = last.focusSelector ? { selector: last.focusSelector, fallbackSelector: restSel } : { selector: restSel };
        kfs.push({ at: round(planRes + panMs / 1000), ...cfgFrame, zoom: z, ease, focusGroup: fgB, seg: si, tAnchor: { ref: resRef, offsetMs: resOff + panMs } }); // glide to node (between typings)
        const commit = sorted.find((e) => (e.at || 0) > (last.at || 0) && (e.at || 0) < scopeEnd && e.type === 'click' && /dialog/i.test(e.selector || ''));
        const oRef = commit ? idxOf(commit) : idxOf(last);
        const oOff = holdMs;
        const planOut = commit ? (commit.at || 0) + holdMs / 1000 : (last.at || 0) + holdMs / 1000;
        kfs.push({ at: round(planOut), ...cfgFrame, zoom: z, ease: 'linear', focusGroup: fgB, seg: si, tAnchor: { ref: oRef, offsetMs: oOff } }); // HOLD on node (typing settings)
        kfs.push({ at: round(planOut + zoomOutMs / 1000), ...outA, zoom: restZoom, ease, seg: si, tAnchor: { ref: oRef, offsetMs: oOff + zoomOutMs } });
      } else {
        kfs.push({ at: round(planRes + zoomOutMs / 1000), ...outA, zoom: restZoom, ease, seg: si, tAnchor: { ref: resRef, offsetMs: resOff + zoomOutMs } });
      }
    } else {
      // Drag (or a config-only session): hold on the framed target, then zoom out.
      kfs.push({ at: round(planOutStart), ...inA, zoom: z, ease: 'linear', focusGroup: fg, seg: si, tAnchor: { ref: outRef, offsetMs: outStartOff } });
      kfs.push({ at: round(planOutStart + zoomOutMs / 1000), ...outA, zoom: restZoom, ease, seg: si, tAnchor: { ref: outRef, offsetMs: outStartOff + zoomOutMs } });
    }

    prevRestSel = isDrag ? (first.focusSelector || restSel) : restSel;
  });
  // Back-to-back hotspot sessions (e.g. drag-connect ending right before the
  // next palette open) used to emit zoomOut → restZoom → zoomIn within ~1.5s,
  // bouncing the camera. We collapse those brief rest runs by lifting the
  // intermediate rest keyframes UP to the surrounding zoom level, so the
  // camera glides between hotspots while staying zoomed. Visual flutter +
  // the parasitic zoomIn/zoomOut SFX cues (derived from these keyframes in
  // record.js) both disappear because dz becomes 0 across the lifted run.
  // 3500ms covers the typical drag→palette gap (~2700ms plan-time, perceived
  // as back-to-back after per-beat speed compression). Anything wider is a
  // genuine pause and gets a real wide-view rest. Tune via cfg.bounceMergeMs.
  return smoothBackToBackBounces(kfs, restZoom, cfg.bounceMergeMs ?? 3500, cfg.bouncePanMs ?? 900);
}

// Best selector to frame an anchor keyframe with. `framePair` ones already
// carry an .a/.b; settings hold on a single selector; drag arrives on a
// framePair. Returns null when no selector can be derived (e.g. a `point`
// anchor with no element to box-fit).
function bridgeSel(anchor) {
  if (!anchor) return null;
  if (anchor.framePair?.b) return anchor.framePair.b;
  if (anchor.framePair?.a) return anchor.framePair.a;
  if (anchor.focusSelector) return anchor.focusSelector;
  if (anchor.selector) return anchor.selector;
  return null;
}
function makeBridgePair(a, b) {
  const sa = bridgeSel(a);
  const sb = bridgeSel(b);
  return sa && sb && sa !== sb ? { a: sa, b: sb } : null;
}

function smoothBackToBackBounces(kfs, restZoom, mergeMs, panMs) {
  if (kfs.length < 4) return kfs;
  const isRest = (kf) => (kf.zoom || 1) <= restZoom + 0.05;
  const zoomedIdx = [];
  kfs.forEach((kf, i) => { if (!isRest(kf)) zoomedIdx.push(i); });
  if (zoomedIdx.length < 2) return kfs;
  // Between two close-enough zoom-ins: drop every intermediate rest kf
  // (their positions point at the wide pane or the previous-session rest
  // spot — interpolating across them slow-pans the camera to nowhere
  // useful), then insert ONE "hold on previous hotspot" kf so the camera
  // sits on the just-completed action until ~PAN_MS before the next one,
  // and leads the cursor over that final window.
  const drop = new Set();
  const insertions = []; // { afterIdx, kf }
  for (let k = 0; k < zoomedIdx.length - 1; k++) {
    const iA = zoomedIdx[k];
    const iB = zoomedIdx[k + 1];
    if (iB - iA <= 1) continue;
    const restDur = (kfs[iB].at - kfs[iA].at) * 1000;
    if (restDur >= mergeMs) continue;
    for (let j = iA + 1; j < iB; j++) {
      if (isRest(kfs[j])) drop.add(j);
    }
    // Skip the linger entirely when the gap is barely larger than the pan
    // itself — adding a same-time keyframe in that case just duplicates iA
    // and confuses the linear-interpolating crop.
    if (restDur <= panMs + 80) continue;
    // Hold the previous hotspot's framing — but anchor the hold to the
    // NEXT zoom-in so its fire time tracks where the camera actually
    // needs to be moving toward (drift-safe under slow cursors). For
    // widely-spaced consecutive hotspots (e.g. macd's strategy node at
    // y=40 right after a plot at y=1873), we replace the static linger
    // with a `framePair` between the two anchors — the fit-zoom logic
    // pulls the camera back during the transition so the user sees a
    // brief context shot instead of a slow drift at high zoom.
    const anchorA = kfs[iA];
    const anchorB = kfs[iB];
    const lingerAt = Math.max(anchorA.at, anchorB.at - panMs / 1000);
    const lingerTAnchor = anchorB.tAnchor
      ? { ref: anchorB.tAnchor.ref, offsetMs: (anchorB.tAnchor.offsetMs || 0) - panMs }
      : anchorA.tAnchor;
    const bridgePair = makeBridgePair(anchorA, anchorB);
    // Bridge framePair: NO focusSelector — that would trigger the wide-drag
    // fallback in resolveCameraPoint and short-circuit our context shot for
    // the very case we want it (far-apart hotspots producing zoom < 1.3).
    // Letting the natural fit-zoom flow through gives a clean pull-out for
    // distant pairs and a near-no-op for close ones.
    const linger = bridgePair
      ? {
          at: Math.round(lingerAt * 100) / 100,
          framePair: bridgePair,
          zoom: anchorA.zoom,
          ease: 'linear',
          tAnchor: lingerTAnchor,
        }
      : {
          ...anchorA,
          at: Math.round(lingerAt * 100) / 100,
          ease: 'linear',
          tAnchor: lingerTAnchor,
        };
    insertions.push({ afterIdx: iA, kf: linger });
  }
  if (!drop.size && !insertions.length) return kfs;
  const kept = kfs.filter((_, i) => !drop.has(i));
  // Splice insertions in by their original anchor's position in `kept`.
  for (const { afterIdx, kf } of insertions) {
    const anchorRef = kfs[afterIdx];
    const newIdx = kept.indexOf(anchorRef);
    if (newIdx >= 0) kept.splice(newIdx + 1, 0, kf);
  }
  // Final sort by time — a hold inserted late could otherwise sit before
  // an earlier-merged neighbour and confuse the linear-interpolating crop.
  kept.sort((a, b) => (a.at || 0) - (b.at || 0));
  return kept;
}
