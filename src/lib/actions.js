// Executes pipeline "actions" against a Playwright page. Used both for a
// scene's `setup` (before timing starts) and its `actions` (during the take).
//
// Design choices:
// - Selector-based, not coordinate-based — selectors survive layout changes.
//   For clicks that genuinely need a spot inside an element (e.g. right-
//   clicking empty canvas) use `position`, an offset relative to the element.
// - A selector that matches several elements resolves to `.first()` unless an
//   explicit `nth` is given — predictable for content automation.
//
// Keyboard note: the target app keys panes off `event.code` (Digit1..Digit6),
// so `key` here is a Playwright key/code token ("Digit1", "Enter", "KeyA", ...)
// and modifiers are explicit booleans.

import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const MODIFIER_ORDER = [
  ['ctrl', 'Control'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'],
];

function keyCombo(action) {
  const mods = MODIFIER_ORDER.filter(([flag]) => action[flag]).map(([, name]) => name);
  return [...mods, action.key].join('+');
}

// Resolve an action's selector to a single locator.
function loc(page, action) {
  if (!action.selector) throw new Error(`"${action.type}" action needs a "selector"`);
  const base = page.locator(action.selector);
  return action.nth !== undefined ? base.nth(action.nth) : base.first();
}

// Shared options for click-family actions.
function clickOpts(action) {
  const opts = { timeout: action.timeoutMs ?? 15000 };
  if (action.position) opts.position = action.position;
  if (action.button) opts.button = action.button;
  if (action.clickCount) opts.clickCount = action.clickCount;
  return opts;
}

async function runAction(page, action) {
  switch (action.type) {
    case 'press': {
      if (!action.key) throw new Error('"press" action needs a "key"');
      await page.keyboard.press(keyCombo(action));
      return;
    }
    case 'type': {
      await page.keyboard.type(action.text ?? '', { delay: action.delay ?? 25 });
      return;
    }
    case 'fill': {
      // Focus, clear, and set an input/textarea in one robust step.
      await loc(page, action).fill(action.text ?? '', { timeout: action.timeoutMs ?? 15000 });
      return;
    }
    case 'click': {
      await loc(page, action).click(clickOpts(action));
      return;
    }
    case 'rightClick': {
      await loc(page, action).click({ ...clickOpts(action), button: 'right' });
      return;
    }
    case 'dblclick': {
      await loc(page, action).dblclick(clickOpts(action));
      return;
    }
    case 'hover': {
      await loc(page, action).hover({ timeout: action.timeoutMs ?? 15000, position: action.position });
      return;
    }
    case 'wait': {
      await page.waitForTimeout(action.ms ?? 0);
      return;
    }
    case 'waitForSelector': {
      if (!action.selector) throw new Error('"waitForSelector" action needs a "selector"');
      await page.waitForSelector(action.selector, {
        state: action.state || 'visible',
        timeout: action.timeoutMs ?? 30000,
      });
      return;
    }
    case 'scroll': {
      if (action.selector) await loc(page, action).hover({ timeout: action.timeoutMs ?? 15000 });
      await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      return;
    }
    case 'mouseMove': {
      await page.mouse.move(action.x ?? 0, action.y ?? 0, { steps: action.steps ?? 10 });
      return;
    }
    case 'drag': {
      // Press on `selector`, glide to a destination, release. Covers both
      // node repositioning (drop at `to` coords) and React Flow handle wiring
      // (drop onto `toSelector`, another handle). Stepped moves are required
      // so React Flow / DnD see intermediate mousemove events.
      const src = loc(page, action);
      const sb = await src.boundingBox();
      if (!sb) throw new Error(`"drag": source "${action.selector}" has no bounding box`);
      const sp = action.position || { x: sb.width / 2, y: sb.height / 2 };
      const sx = sb.x + sp.x;
      const sy = sb.y + sp.y;

      let tx;
      let ty;
      if (action.toSelector) {
        const dst = page.locator(action.toSelector).first();
        const db = await dst.boundingBox();
        if (!db) throw new Error(`"drag": toSelector "${action.toSelector}" has no bounding box`);
        const tp = action.toPosition || { x: db.width / 2, y: db.height / 2 };
        tx = db.x + tp.x;
        ty = db.y + tp.y;
      } else if (action.to) {
        tx = action.to.x;
        ty = action.to.y;
      } else {
        throw new Error('"drag" action needs "to" {x,y} or "toSelector"');
      }

      const steps = action.steps ?? 20;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 8, sy + 4, { steps: 4 }); // nudge to start the drag
      await page.mouse.move(tx, ty, { steps });
      await page.mouse.move(tx, ty, { steps: 3 }); // settle on the target
      await page.mouse.up();
      return;
    }
    case 'eval': {
      if (!action.script) throw new Error('"eval" action needs a "script"');
      // Runs the expression string in the page context.
      await page.evaluate(action.script);
      return;
    }
    case 'injectFlow': {
      // Build a node graph via the target app's `window.__injectFlow` test hook
      // — far more reliable than choreographing drags. `file` is a flow JSON
      // ({ nodes, edges }); optional `nodeCount` injects only the first N nodes
      // (+ edges among them) so a scene can animate the build progressively.
      if (!action.file) throw new Error('"injectFlow" action needs a "file"');
      const flowPath = path.resolve(action.file);
      if (!fs.existsSync(flowPath)) throw new Error(`"injectFlow": flow file not found: ${flowPath}`);
      const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
      let nodes = flow.nodes || [];
      let edges = flow.edges || [];
      if (action.nodeCount !== undefined) {
        nodes = nodes.slice(0, action.nodeCount);
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      }
      const ok = await page.evaluate(({ n, e }) => {
        if (typeof window.__injectFlow !== 'function') return false;
        window.__injectFlow({ nodes: n, edges: e });
        return true;
      }, { n: nodes, e: edges });
      if (!ok) throw new Error('"injectFlow": window.__injectFlow is not available on the page');
      return;
    }
    default:
      throw new Error(`Unknown action type: "${action.type}"`);
  }
}

export async function runActions(page, actions, label = 'actions', hooks = {}) {
  if (!actions || actions.length === 0) return;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const detail =
      action.selector ? ` ${action.selector}` :
      action.key ? ` ${keyCombo(action)}` :
      action.ms !== undefined ? ` ${action.ms}ms` : '';
    log.info(`  ${label}[${i}]: ${action.type}${detail}`);
    // `focus` is a camera-keyframe marker, not a page interaction: it tells the
    // recorder to centre the (panning) crop window on `selector` at this moment.
    if (action.type === 'focus') {
      if (hooks.onFocus) await hooks.onFocus(action);
      continue;
    }
    await runAction(page, action);
  }
}
