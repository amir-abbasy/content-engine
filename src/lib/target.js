// Resolves a scene's `target` to a pixel rectangle inside the recorded video.
// deviceScaleFactor is 1 and recordVideo.size === viewport, so CSS px map 1:1
// to video px.
//
// Pipeline:  base box (selector/pane/region/viewport)
//         -> apply padding
//         -> carve an aspect-ratio sub-rect, anchored (for true 9:16 framing)
//         -> clamp to viewport, round to even.

// Named-pane shortcuts for the "vite - Flow" trading app. `pane` resolves the
// inner marker element, then climbs to its [data-panel] ancestor (react-
// resizable-panels) so the whole panel — header included — is captured.
const PANE_SELECTOR = {
  chart: '#main-chart',
  flow: '.react-flow',
  result: '[data-testid="backtest-panel"]',
};

const even = (n) => Math.round(n / 2) * 2;

function normalizePadding(padding) {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return { top: padding.top || 0, right: padding.right || 0, bottom: padding.bottom || 0, left: padding.left || 0 };
}

// "9:16" -> 0.5625. Accepts "W:H" or a number.
function parseAspect(aspect) {
  if (aspect === undefined) return null;
  if (typeof aspect === 'number') return aspect;
  const [w, h] = String(aspect).split(':').map(Number);
  if (!w || !h) throw new Error(`Invalid aspect "${aspect}" — use "W:H" e.g. "9:16"`);
  return w / h;
}

// Carve the largest sub-rectangle of `box` with the given width/height ratio,
// positioned by `anchor` (e.g. "right", "top-right", "center", "bottom").
function carveAspect(box, ratio, anchor = 'center') {
  const boxRatio = box.width / box.height;
  let width = box.width;
  let height = box.height;
  if (boxRatio > ratio) {
    // Box is wider than the target — full height, narrower width.
    height = box.height;
    width = height * ratio;
  } else {
    // Box is taller/narrower than the target — full width, shorter height.
    width = box.width;
    height = width / ratio;
  }

  const a = String(anchor).toLowerCase();
  const hPart = a.includes('left') ? 'left' : a.includes('right') ? 'right' : 'center';
  const vPart = a.includes('top') ? 'top' : a.includes('bottom') ? 'bottom' : 'center';

  let x = box.x;
  if (hPart === 'center') x = box.x + (box.width - width) / 2;
  else if (hPart === 'right') x = box.x + (box.width - width);

  let y = box.y;
  if (vPart === 'center') y = box.y + (box.height - height) / 2;
  else if (vPart === 'bottom') y = box.y + (box.height - height);

  return { x, y, width, height };
}

async function resolveInPage(page, target) {
  return page.evaluate(
    ({ t, paneMap }) => {
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      if (t.fullViewport) {
        return { ok: true, x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      }
      if (t.region) {
        return { ok: true, ...t.region };
      }
      if (t.paneIndex !== undefined) {
        const panels = document.querySelectorAll('[data-panel]');
        const el = panels[t.paneIndex];
        if (!el) return { ok: false, reason: `paneIndex ${t.paneIndex} out of range (found ${panels.length})` };
        return { ok: true, ...rectOf(el) };
      }
      if (t.pane) {
        const inner = paneMap[t.pane];
        if (!inner) return { ok: false, reason: `unknown pane "${t.pane}"` };
        const el = document.querySelector(inner);
        if (!el) return { ok: false, reason: `pane "${t.pane}" element (${inner}) not in DOM` };
        const panel = el.closest('[data-panel]') || el;
        return { ok: true, ...rectOf(panel) };
      }
      if (t.selector) {
        const el = document.querySelector(t.selector);
        if (!el) return { ok: false, reason: `selector "${t.selector}" not in DOM` };
        return { ok: true, ...rectOf(el) };
      }
      return { ok: false, reason: 'target has no resolvable key' };
    },
    { t: target, paneMap: PANE_SELECTOR },
  );
}

// Returns { x, y, width, height } — even integers, clamped to the viewport.
export async function resolveTarget(page, target, viewport) {
  const res = await resolveInPage(page, target);
  if (!res.ok) throw new Error(`Cannot resolve scene target: ${res.reason}`);

  const pad = normalizePadding(target.padding);
  let box = {
    x: res.x + pad.left,
    y: res.y + pad.top,
    width: res.width - pad.left - pad.right,
    height: res.height - pad.top - pad.bottom,
  };

  // Carve a fixed-aspect sub-rectangle (true 9:16 framing, no squish).
  const ratio = parseAspect(target.aspect);
  if (ratio) box = carveAspect(box, ratio, target.anchor);

  let { x, y, width, height } = box;

  // Clamp into the recorded frame.
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > viewport.width) width = viewport.width - x;
  if (y + height > viewport.height) height = viewport.height - y;

  x = even(x);
  y = even(y);
  width = even(width);
  height = even(height);

  if (width < 2 || height < 2) {
    throw new Error(`Resolved target region is empty (${width}x${height}) — check selector/padding`);
  }
  return { x, y, width, height };
}
