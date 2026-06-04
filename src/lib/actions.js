// Per-event handlers for the timeline scheduler. Each handler runs ONE typed
// event and may take real time (cursor travel, keystrokes, etc.); the
// scheduler in timeline.js decides WHEN each is dispatched.
//
// Cursor-bearing events (`click`, `rightClick`, `dblclick`, `hover`, `fill`)
// route through the humanized cursor driver before the underlying action
// fires — that's what produces curved travel, overshoot, and hover hesitation
// instead of Playwright's teleport-and-click. The driver also tracks the
// cursor's "current" position so successive moves chain from where it is.
//
// Pre-action pauses (config: `record.humanize.preActionPause`) are inserted
// before cursor-bearing events: a tiny randomized beat before the gesture
// starts, the way a human's hand briefly stalls before reaching for a target.

import fs from 'node:fs';
import path from 'node:path';
import { sample } from './humanize.js';

const MODIFIER_ORDER = [
  ['ctrl', 'Control'],
  ['alt',  'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'],
];

function keyCombo(ev) {
  const mods = MODIFIER_ORDER.filter(([flag]) => ev[flag]).map(([, name]) => name);
  return [...mods, ev.key].join('+');
}

const CURSOR_BEARING = new Set(['click', 'rightClick', 'dblclick', 'hover', 'fill', 'drag']);

// Selector-resolution timeout for input actions. A missing/misnamed selector
// must fail fast — at Playwright's 30s default a single bad click would balloon
// the recording by half a minute (and the video clip with it). Override per
// event with `timeoutMs` when an element legitimately needs longer to appear.
const ACTION_TIMEOUT_MS = 6000;

// Resolve the absolute viewport coords for a selector + optional position.
async function resolveTargetPoint(page, ev) {
  // An explicit absolute point wins (used for context-menu adds whose click
  // must land at a computed flow coordinate, not a DOM element's box).
  if (ev.point) return { x: ev.point.x, y: ev.point.y };
  if (!ev.selector) throw new Error(`"${ev.type}" needs a "selector"`);
  const base = page.locator(ev.selector);
  const loc = ev.nth !== undefined ? base.nth(ev.nth) : base.first();
  const box = await loc.boundingBox({ timeout: ev.timeoutMs ?? ACTION_TIMEOUT_MS });
  if (!box) throw new Error(`"${ev.selector}" has no bounding box`);
  const pos = ev.position || { x: box.width / 2, y: box.height / 2 };
  return { x: box.x + pos.x, y: box.y + pos.y };
}

// A React Flow handle selector, e.g.
// `.react-flow__node[data-id="8"] .react-flow__handle[data-handleid="input-0"]`.
const HANDLE_RE = /\.react-flow__node\[data-id="([^"]+)"\]\s+\.react-flow__handle\[data-handleid="(output|input)-(\d+)"\]/;

// Resolve a drag endpoint. For a HANDLE selector, the app sometimes renders a
// handle id that differs from the flow's edge (optional/dynamic inputs shift the
// numbering, e.g. a Plot Shape whose "condition" renders as input-1 not input-0).
// So: try the exact id; if absent, pick the Nth handle of that kind (sorted by
// index) — the same positional input the edge meant. Non-handle selectors fall
// back to the normal box resolver.
// React Flow renders ALL of a node's source handles (and ditto target handles)
// at the same screen position (top: 50% with translateY(-50%)). They overlap
// as a stack of 8x8 boxes. Without intervention, a mousedown at that position
// hits whichever sibling is last in DOM order (highest z), not the handle we
// actually want. Before a wire drag, we lift the requested handle's z-index
// so the cursor's hit-test resolves to it; afterwards we restore so the DOM
// is left untouched. Without this, dragging from `output-1` on a multi-output
// node like STRATEGY.RUN silently connects from `output-5` (final_equity).
async function liftHandle(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return { z: el.style.zIndex || '' };
  }, sel).then(async (prev) => {
    if (!prev) return null;
    await page.evaluate(({ s }) => {
      const el = document.querySelector(s);
      if (el) el.style.zIndex = '9999';
    }, { s: sel });
    return prev;
  });
}
async function restoreHandle(page, sel, prev) {
  if (!prev) return;
  await page.evaluate(({ s, z }) => {
    const el = document.querySelector(s);
    if (el) el.style.zIndex = z;
  }, { s: sel, z: prev.z });
}

async function resolveDragPoint(page, selector, ev) {
  const m = HANDLE_RE.exec(selector || '');
  if (!m) return resolveTargetPoint(page, { ...ev, selector });
  const [, nodeId, kind, idxStr] = m;
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).first()
    .waitFor({ state: 'visible', timeout: ev.timeoutMs ?? ACTION_TIMEOUT_MS }).catch(() => {});
  const pt = await page.evaluate(({ nodeId, kind, idx }) => {
    const node = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
    if (!node) return null;
    const handles = [...node.querySelectorAll('.react-flow__handle')]
      .map((h) => ({ id: h.getAttribute('data-handleid'), src: h.classList.contains('source'), el: h }))
      .filter((h) => h.id && (kind === 'output') === h.src);
    let chosen = handles.find((h) => h.id === `${kind}-${idx}`);
    if (!chosen) {
      handles.sort((a, b) => (+a.id.split('-')[1]) - (+b.id.split('-')[1]));
      chosen = handles[idx] || handles[handles.length - 1];
    }
    if (!chosen) return null;
    const r = chosen.el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { nodeId, kind, idx: Number(idxStr) });
  if (!pt) throw new Error(`drag handle not found: ${selector}`);
  return pt;
}

// Run a single event. `ctx` carries page, cursor, rng, humanize config.
export async function runEvent(ev, ctx) {
  // Tiny pre-action hesitation — humans don't fire the next click on the
  // same frame they finished the last one.
  if (CURSOR_BEARING.has(ev.type)) {
    const pap = ctx.humanize?.preActionPause;
    if (pap) {
      const ms = Math.round(sample(ctx.rng, pap, { fallback: 0 }));
      if (ms > 0) await ctx.page.waitForTimeout(ms);
    }
  }

  switch (ev.type) {
    case 'press': {
      if (!ev.key) throw new Error('"press" needs a "key"');
      await ctx.page.keyboard.press(keyCombo(ev));
      return;
    }

    case 'type': {
      const delay = ev.delay ?? Math.round(sample(ctx.rng, [40, 95], { fallback: 50 }));
      await ctx.page.keyboard.type(ev.text ?? '', { delay });
      return;
    }

    case 'fill': {
      // Visible typing, not Playwright's instant `.fill()`: move cursor →
      // click to focus → clear any existing content → type each char with a
      // jittered delay. Looks like a human typing, not a script teleporting
      // text into a box.
      const pt = await resolveTargetPoint(ctx.page, ev);
      await ctx.cursor.moveTo(pt.x, pt.y);
      await ctx.cursor.hesitate();
      await ctx.page.mouse.click(pt.x, pt.y);
      const base = ctx.page.locator(ev.selector);
      const loc = ev.nth !== undefined ? base.nth(ev.nth) : base.first();
      await loc.fill('', { timeout: ev.timeoutMs ?? ACTION_TIMEOUT_MS });
      const text = ev.text ?? '';
      const keyDelay = ev.delay; // optional override
      for (const ch of text) {
        await ctx.page.keyboard.type(ch);
        const wait = keyDelay !== undefined
          ? Math.round(sample(ctx.rng, keyDelay, { fallback: 30 }))
          : Math.round(sample(ctx.rng, [22, 50], { fallback: 30 }));
        if (wait > 0) await ctx.page.waitForTimeout(wait);
      }
      return;
    }

    case 'click':
    case 'rightClick':
    case 'dblclick': {
      const pt = await resolveTargetPoint(ctx.page, ev);
      await ctx.cursor.moveTo(pt.x, pt.y);
      await ctx.cursor.hesitate();
      const button = ev.type === 'rightClick' ? 'right' : (ev.button || 'left');
      if (ev.type === 'dblclick') {
        await ctx.page.mouse.dblclick(pt.x, pt.y, { button });
      } else {
        await ctx.page.mouse.click(pt.x, pt.y, { button });
      }
      return;
    }

    case 'hover': {
      const pt = await resolveTargetPoint(ctx.page, ev);
      await ctx.cursor.moveTo(pt.x, pt.y);
      return;
    }

    case 'drag': {
      // Wire up an edge (or move anything): press the source, glide to the
      // destination while held, release. `toSelector` resolves the target
      // element (e.g. a target handle); `to` is absolute coords. `position` /
      // `toPosition` offset within each element. For React Flow handles, give
      // the source output handle and target input handle.
      const from = await resolveDragPoint(ctx.page, ev.selector, ev);
      let to;
      if (ev.toSelector) {
        to = await resolveDragPoint(ctx.page, ev.toSelector, { nth: ev.toNth, position: ev.toPosition, timeoutMs: ev.timeoutMs });
      } else if (ev.to) {
        to = { x: ev.to.x, y: ev.to.y };
      } else {
        throw new Error('"drag" needs "to" {x,y} or "toSelector"');
      }
      await ctx.cursor.moveTo(from.x, from.y);
      await ctx.cursor.hesitate();
      await ctx.page.mouse.down();
      await ctx.page.waitForTimeout(40); // let dragstart register before moving
      await ctx.cursor.moveTo(to.x, to.y);
      await ctx.cursor.hesitate();
      await ctx.page.mouse.up();
      return;
    }

    case 'wait': {
      const ms = ev.ms !== undefined
        ? Math.round(sample(ctx.rng, ev.ms, { jitter: ctx.humanize?.jitter || 0, fallback: 0 }))
        : 0;
      if (ms > 0) await ctx.page.waitForTimeout(ms);
      return;
    }

    case 'waitForSelector': {
      if (!ev.selector) throw new Error('"waitForSelector" needs a "selector"');
      await ctx.page.waitForSelector(ev.selector, {
        state: ev.state || 'visible',
        timeout: ev.timeoutMs ?? 30000,
      });
      return;
    }

    case 'scroll': {
      if (ev.selector) {
        const pt = await resolveTargetPoint(ctx.page, ev);
        await ctx.cursor.moveTo(pt.x, pt.y);
      }
      await ctx.page.mouse.wheel(ev.deltaX ?? 0, ev.deltaY ?? 0);
      return;
    }

    case 'eval': {
      if (!ev.script) throw new Error('"eval" needs a "script"');
      await ctx.page.evaluate(ev.script);
      return;
    }

    case 'injectFlow': {
      if (!ev.file) throw new Error('"injectFlow" needs a "file"');
      const flowPath = path.resolve(ev.file);
      if (!fs.existsSync(flowPath)) throw new Error(`injectFlow: ${flowPath} not found`);
      const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
      let nodes = flow.nodes || [];
      let edges = flow.edges || [];
      if (ev.nodeCount !== undefined) {
        nodes = nodes.slice(0, ev.nodeCount);
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      }
      const ok = await ctx.page.evaluate(({ n, e }) => {
        if (typeof window.__injectFlow !== 'function') return false;
        window.__injectFlow({ nodes: n, edges: e });
        return true;
      }, { n: nodes, e: edges });
      if (!ok) throw new Error('"injectFlow": window.__injectFlow is not available on the page');
      return;
    }

    default:
      // Camera/reveal/attention are dispatched in record.js, never here.
      throw new Error(`Unknown input event type: "${ev.type}"`);
  }
}
