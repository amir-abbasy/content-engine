// Generate the recording steps for a strategy straight from its flow — no AI,
// no hand-authoring. Everything (build order, which nodes, the wiring) is
// derived by scripts/lib/build-flow.js. This turns that into recorder steps:
//
//   per node:  rightClick (addsNodeId) -> fill search -> click result -> injectFlow
//              [-> enter its settings on camera, when configOnCamera]
//   per edge:  drag source-handle -> target-handle
//   + click Execute
//
// Two output modes (per strategy, see STRATEGIES):
//   'single' — writes a full standalone pipeline (CONFIG.pipelineOut): the WHOLE
//              flow built in one scene. Used for a new strategy.
//   'split'  — rewrites only one scene's setup/input in an existing pipeline
//              (CONFIG.sceneId in CONFIG.pipelineOut); the base build lives in a
//              separate earlier scene.
//
//   npm run gen:pipeline                  (default strategy)
//   STRATEGY=rsi npm run gen:pipeline     (a specific one)
//   STRATEGY=rsi npm run gen              (fixture + pipeline)

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'node:path';
import { buildFlow, getStrategy, ROOT, nameOf } from './lib/build-flow.js';

const FLOW = process.argv[2] || process.env.STRATEGY || 'ema';
const CONFIG = getStrategy(FLOW);

const SEARCH = 'input[placeholder="Search nodes..."]';
// Pacing (seconds). The block period is the sum of the per-node steps.
const T = {
  firstAddAt: 0.8,
  rcToFill: 1.0, fillToClick: 2.4, clickToConfig: 1.1,
  blockGap: 1.4, dragGap: 2.0, lastDragToExecute: 3.0, executeToEnd: 4.5,
};
// Observed deterministic fit — only the right-click FALLBACK position; at record
// time `addsNodeId` re-measures each node's true centre and overrides this.
const FIT = { scale: 0.681211, tx: -343.068, ty: 72.0764, ox: 5, oy: 48 };

const r1 = (n) => Math.round(n * 10) / 10;
const handleSel = (id, h) => `.react-flow__node[data-id="${id}"] .react-flow__handle[data-handleid="${h}"]`;
const nodeSel = (id) => `.react-flow__node[data-id="${id}"]`;
const fallbackPos = (n) => ({
  x: Math.round(FIT.ox + n.position.x * FIT.scale + FIT.tx + 40),
  y: Math.round(FIT.oy + n.position.y * FIT.scale + FIT.ty + 30),
});

const { nodes, dragged, baseIds, addedIds } = buildFlow(CONFIG);
const nodeById = (id) => nodes.find((n) => n.id === id);
const fixture = CONFIG.out;

const searchText = (n) => CONFIG.searchOverrides?.[n.data.nodeKey]?.search ?? n.data.Name.toLowerCase();
const menuLabel = (n) => CONFIG.searchOverrides?.[n.data.nodeKey]?.menu ?? n.data.Name;

// The on-camera settings to enter for a node, derived from its flow data.
// Returns partial events with a `_dur` (seconds to the next step).
function configSteps(node, id) {
  if (!CONFIG.configOnCamera) return [];
  const out = [];
  const d = node.data;
  const iv = d.inputValues || {};
  const pre = nodeSel(id);
  // numeric "int" inputs (RSI/EMA length, MACD fast/slow/signal, …). They all
  // render as input[placeholder="int"], so target the Nth one (k = position
  // among the node's int inputs) — a multi-period node like MACD has several.
  (d.Inputs || []).filter((i) => i.type === 'int').forEach((inp, k) => {
    const idx = d.Inputs.indexOf(inp);
    const v = iv[inp.name] ?? iv[String(idx)] ?? inp.default;
    if (v != null) out.push({ type: 'fill', selector: `${pre} input[placeholder="int"]`, nth: k, text: String(v), focusZoom: 2.4, _dur: 1.8 });
  });
  // crossover/crossunder threshold (the "b" operand shows as input[placeholder="array"])
  if (d.nodeKey === 'crossover' || d.nodeKey === 'crossunder') {
    const v = iv['1'] ?? d.Inputs?.[1]?.default;
    if (v != null) out.push({ type: 'fill', selector: `${pre} input[placeholder="array"]`, text: String(v), focusZoom: 2.4, _dur: 1.8 });
  }
  // plot colour: open the swatch, pick from the palette (the picker carries a
  // fixed set of hex swatches; the flow's colours are in it).
  if (d.isPlotNode && d.plotConfig?.color) {
    const color = String(d.plotConfig.color).toLowerCase();
    out.push({ type: 'click', selector: `${pre} .aspect-square`, focusZoom: 2.0, focusSelector: '[role="dialog"]', _dur: 1.2 });
    out.push({ type: 'click', selector: `[role="dialog"] button[title="${color}"]`, _dur: 1.2 });
  }
  return out;
}

// ── setup: inject the full flow (fit + sticky viewport), clear back to the set
// the earlier scene already built (0 for a single-scene build).
const setup = [
  { at: 0.0, type: 'press', key: 'Digit2', shift: true },
  { at: 0.4, type: 'injectFlow', file: fixture },
  { at: 1.6, type: 'press', key: 'Digit2', shift: true },
  { at: 2.0, type: 'injectFlow', file: fixture, nodeCount: baseIds.length },
];

// Build the flow node-by-node: add a node (+ enter its settings), then
// immediately WIRE EVERY CONNECTION that just became possible (both endpoints
// now on the canvas) — i.e. the new node's inputs from already-placed nodes.
// This reads like a human building the strategy, not "add everything, then wire
// it all at the end". An edge is drawn right after its later endpoint appears.
const input = [];
const attention = []; // markers that prime the eye on each input being edited
let dragCount = 0;
const pending = [...dragged].sort((a, b) =>
  (Number(a.target) - Number(b.target)) || a.sourceHandle.localeCompare(b.sourceHandle) || a.targetHandle.localeCompare(b.targetHandle));
// Nodes already on the canvas when the scene starts: the base set in split mode
// (built by an earlier scene); nothing in single mode. Edges flush once both
// endpoints are present, so seeding this lets a new node's inputs from base
// nodes wire immediately.
const added = new Set(baseIds);
let t = T.firstAddAt;
for (const id of addedIds) {
  const n = nodeById(id);
  const rcAt = t;
  const fillAt = rcAt + T.rcToFill;
  const clickAt = fillAt + T.fillToClick;
  // Add the node via the REAL context-menu pick (not injectFlow): it APPENDS a
  // node with the next sequential id (== build order) and, crucially, leaves the
  // edges already drawn intact. An injectFlow per add would replace the whole
  // graph and wipe the wiring done for earlier nodes.
  // Everything this node touches (search + each setting) shares one focusSession,
  // so the auto-camera does ONE zoom that glides across them, not a zoom per edit.
  const ses = Number(id);
  input.push({ at: r1(rcAt), type: 'rightClick', selector: '.react-flow__pane', position: fallbackPos(n), addsNodeId: Number(id) });
  input.push({ at: r1(fillAt), type: 'fill', selector: SEARCH, text: searchText(n), focusZoom: 2.0, focusSession: ses });
  // Match the menu item by EXACT leaf text, so e.g. "RSI" doesn't hit "CRSI"
  // and "Plot" doesn't hit "Plot Trades".
  input.push({ at: r1(clickAt), type: 'click', selector: `[role="menuitem"]:has(:text-is("${menuLabel(n)}"))` });
  const steps = configSteps(n, id);
  let ct = clickAt + T.clickToConfig;
  for (const step of steps) {
    const { _dur, ...ev } = step;
    input.push({ at: r1(ct), ...ev, focusSession: ses });
    // Prime a marker on the node input/swatch ~0.4s before it's edited.
    if (ev.selector && ev.selector.includes('react-flow__node')) {
      attention.push({ at: r1(Math.max(0, ct - 0.4)), type: 'mark', selector: ev.selector, ...(ev.nth !== undefined ? { nth: ev.nth } : {}), padding: 4, durationMs: 1200 });
    }
    ct += _dur || 1.6;
  }
  added.add(id);
  // Wire every edge whose BOTH endpoints are now present (mostly this node's
  // freshly-addable inputs). framePair (autocamera) frames both endpoints.
  const ready = pending.filter((e) => added.has(e.source) && added.has(e.target));
  let dt = ct + T.blockGap;
  for (const e of ready) {
    input.push({ at: r1(dt), type: 'drag', selector: handleSel(e.source, e.sourceHandle), toSelector: handleSel(e.target, e.targetHandle), focusZoom: 1.6, focusSelector: nodeSel(e.target) });
    pending.splice(pending.indexOf(e), 1);
    dt += T.dragGap;
    dragCount++;
  }
  t = ready.length ? dt + T.blockGap : ct + T.blockGap; // extra beat after wiring
}
// Any edges left (endpoints exist but never flushed — shouldn't happen) draw now.
for (const e of pending) {
  input.push({ at: r1(t), type: 'drag', selector: handleSel(e.source, e.sourceHandle), toSelector: handleSel(e.target, e.targetHandle), focusZoom: 1.6, focusSelector: nodeSel(e.target) });
  t += T.dragGap; dragCount++;
}

// ── run the backtest.
const executeAt = r1(t + T.lastDragToExecute);
input.push({ at: executeAt, type: 'click', selector: 'button[title="Execute flow"]' });
const durationSec = r1(executeAt + T.executeToEnd);

// ── write output.
const pipePath = path.resolve(ROOT, 'pipeline.json'); // template for app/record/output
const template = JSON.parse(readFileSync(pipePath, 'utf8'));
const outPath = path.resolve(ROOT, CONFIG.pipelineOut);
mkdirSync(path.dirname(outPath), { recursive: true });

if (CONFIG.mode === 'single') {
  const scene = {
    id: CONFIG.sceneId,
    description: `Build the complete ${FLOW.toUpperCase()} strategy on camera: add every node, enter its settings, draw every connection, then run the backtest. Fully generated from ${CONFIG.src} by scripts/gen-pipeline.js.`,
    target: { selector: '.react-flow', aspect: '9:16', anchor: 'center' },
    setup,
    durationSec,
    holdAfterSec: 2.0,
    autoCamera: true,
    tracks: { input, ...(attention.length ? { attention } : {}) },
  };
  // After the build runs, switch from the node editor (Shift+2) back to the
  // chart view (Shift+1) — the executed plots persist across the toggle in the
  // same session — and drag the chart back a little to reveal the result.
  const chartScene = {
    id: 'chart-reveal',
    description: `Reveal the chart with the plotted ${FLOW.toUpperCase()} result after running the strategy.`,
    target: { selector: '#main-chart', aspect: '9:16', anchor: 'center' },
    setup: [{ at: 0.0, type: 'press', key: 'Digit1', shift: true }],
    durationSec: 6.0,
    holdAfterSec: 1.0,
    autoCamera: false,
    tracks: {
      input: [
        // Pan the chart into the PAST: grab the plot area and drag RIGHTWARD so
        // older bars scroll in from the left (dragging left would chase the newest
        // bars — you're already there, so nothing moves). A wide, centred drag.
        { at: 1.4, type: 'drag', point: { x: 950, y: 540 }, to: { x: 1550, y: 540 } },
      ],
    },
  };
  const pipeline = {
    name: `${FLOW}-strategy-reel`,
    app: template.app,
    record: template.record,
    output: template.output,
    scenes: [scene, chartScene],
  };
  writeFileSync(outPath, serialize(pipeline) + '\n');
  console.log(`wrote ${CONFIG.pipelineOut} (single-scene build)`);
} else {
  const pipeline = JSON.parse(readFileSync(outPath, 'utf8'));
  let scene = pipeline.scenes.find((s) => s.id === CONFIG.sceneId);
  if (!scene) { scene = { id: CONFIG.sceneId, target: { selector: '.react-flow', aspect: '9:16', anchor: 'center' }, holdAfterSec: 2.0, autoCamera: true, tracks: {} }; pipeline.scenes.push(scene); }
  scene.setup = setup;
  scene.durationSec = durationSec;
  scene.tracks = scene.tracks || {};
  scene.tracks.input = input;
  writeFileSync(outPath, serialize(pipeline) + '\n');
  console.log(`updated ${CONFIG.pipelineOut} scene "${CONFIG.sceneId}"`);
}

console.log(`  nodes built: ${addedIds.map((id) => `${nameOf(nodes, id)} #${id}`).join(', ')}`);
console.log(`  ${addedIds.length} adds, ${dragCount} wiring drags (interleaved)${CONFIG.configOnCamera ? ', configs on camera' : ''}, execute @${executeAt}s, durationSec ${durationSec}`);

// Pretty-print but keep "leaf" objects (events, points, small configs) on one
// line, matching the hand-authored pipeline.json style.
function serialize(value, ind = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const ni = ind + '  ';
    return '[\n' + value.map((v) => ni + serialize(v, ni)).join(',\n') + '\n' + ind + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const primitive = (x) => x === null || typeof x !== 'object';
    const inline = 'type' in value || (keys.length <= 4 && keys.every((k) => primitive(value[k])));
    if (inline) return JSON.stringify(value);
    if (keys.length === 0) return '{}';
    const ni = ind + '  ';
    return '{\n' + keys.map((k) => ni + JSON.stringify(k) + ': ' + serialize(value[k], ni)).join(',\n') + '\n' + ind + '}';
  }
  return JSON.stringify(value);
}
