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

const CURSOR_BEARING = new Set(['click', 'rightClick', 'dblclick', 'hover', 'fill']);

// Resolve the absolute viewport coords for a selector + optional position.
async function resolveTargetPoint(page, ev) {
  if (!ev.selector) throw new Error(`"${ev.type}" needs a "selector"`);
  const base = page.locator(ev.selector);
  const loc = ev.nth !== undefined ? base.nth(ev.nth) : base.first();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`"${ev.selector}" has no bounding box`);
  const pos = ev.position || { x: box.width / 2, y: box.height / 2 };
  return { x: box.x + pos.x, y: box.y + pos.y };
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
      const loc = ctx.page.locator(ev.selector).first();
      await loc.fill('');
      const text = ev.text ?? '';
      const keyDelay = ev.delay; // optional override
      for (const ch of text) {
        await ctx.page.keyboard.type(ch);
        const wait = keyDelay !== undefined
          ? Math.round(sample(ctx.rng, keyDelay, { fallback: 80 }))
          : Math.round(sample(ctx.rng, [55, 135], { fallback: 80 }));
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
