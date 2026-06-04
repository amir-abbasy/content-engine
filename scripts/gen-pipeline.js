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
const pending = [...dragged].sort((a, b) =>
  (Number(a.target) - Number(b.target)) || a.sourceHandle.localeCompare(b.sourceHandle) || a.targetHandle.localeCompare(b.targetHandle));

// A strategy node is the backtest engine (`strategy.*`) or the trade-overlay
// renderer (`plot.trades`). When ANY of these exist, the build splits in two:
// indicators/plots first (phase A), then the backtest wiring (phase B). The
// chart reveal + Backtest Results overview then play as their own scenes. A
// pure plotting flow (no such node) keeps the single-scene shape.
const isStrategyId = (id) => {
  const k = nodeById(id)?.data?.nodeKey || '';
  return k.startsWith('strategy.') || k === 'plot.trades';
};
const plotIds = addedIds.filter((id) => !isStrategyId(id));
const stratIds = addedIds.filter((id) => isStrategyId(id));
const hasStrategyPhase = stratIds.length > 0;

// Process one phase: add each id (with on-camera settings), then drain every
// pending edge whose BOTH endpoints are now on the canvas. Mutates `pending`
// (so edges that touch a not-yet-added strategy node naturally roll into the
// next phase) and returns the resulting input/attention/timing.
function processIds(idsToAdd, addedSoFar, startT = T.firstAddAt) {
  const input = [];
  const attention = [];
  let dragCount = 0;
  let t = startT;
  const added = new Set(addedSoFar);
  for (const id of idsToAdd) {
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
    // `flowPos` carries the node's flow-coords; the recorder converts them
    // live via the React Flow viewport transform, which always reflects the
    // current layout (auto-fit, post-execute pane resize, repositioned strategy
    // nodes, etc.). `position` is kept as a last-ditch FIT-based fallback.
    input.push({ at: r1(rcAt), type: 'rightClick', selector: '.react-flow__pane', position: fallbackPos(n), flowPos: { x: n.position.x, y: n.position.y }, addsNodeId: Number(id) });
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
  return { input, attention, dragCount, t, added };
}

// Plot/indicator nodes are added first; if the flow has strategy/trade nodes,
// they're added right after in the SAME build scene (no intermediate execute
// or chart reveal) so the build reads as one continuous left-to-right wiring
// sequence. A single Execute at the very end triggers both the plots and the
// backtest in one pass.
const phaseA = processIds(plotIds, baseIds);
const phaseB = hasStrategyPhase
  ? processIds(stratIds, phaseA.added, phaseA.t)
  : null;

const combined = {
  input: phaseB ? [...phaseA.input, ...phaseB.input] : phaseA.input,
  attention: phaseB ? [...phaseA.attention, ...phaseB.attention] : phaseA.attention,
  dragCount: phaseA.dragCount + (phaseB?.dragCount || 0),
  t: phaseB?.t ?? phaseA.t,
  added: phaseB?.added ?? phaseA.added,
};

// Drain any pending edges whose endpoints are now both on canvas (safety net —
// the per-node loop drains as it goes), then click Execute. One execute at
// the very end runs the indicators AND the backtest in one pass.
for (const e of pending.filter((edge) => combined.added.has(edge.source) && combined.added.has(edge.target))) {
  combined.input.push({ at: r1(combined.t), type: 'drag', selector: handleSel(e.source, e.sourceHandle), toSelector: handleSel(e.target, e.targetHandle), focusZoom: 1.6, focusSelector: nodeSel(e.target) });
  pending.splice(pending.indexOf(e), 1);
  combined.t += T.dragGap; combined.dragCount++;
}
const executeAt = r1(combined.t + T.lastDragToExecute);
combined.input.push({ at: executeAt, type: 'click', selector: 'button[title="Execute flow"]' });
const durationSec = r1(executeAt + T.executeToEnd);
const dragCount = combined.dragCount;

// ── write output.
const pipePath = path.resolve(ROOT, 'pipeline.json'); // template for app/record/output
const template = JSON.parse(readFileSync(pipePath, 'utf8'));
const outPath = path.resolve(ROOT, CONFIG.pipelineOut);
mkdirSync(path.dirname(outPath), { recursive: true });

if (CONFIG.mode === 'single') {
  // ONE continuous build scene → chart reveal → (when there's a backtest)
  // the Backtest Results panel. The build scene adds plot/indicator nodes
  // first, then any strategy.* + plot.trades nodes right after in the same
  // session, and executes once at the end so the chart already has trades
  // when it's revealed. The auto-layout in build-flow.js parks strategy
  // nodes in a horizontal lane right of the plots so the camera flows
  // left-to-right and never pulls back to fit far-flung positions.
  const scenes = [{
    id: CONFIG.sceneId,
    description: `Build the complete ${FLOW.toUpperCase()} strategy on camera: add every node (indicators first, then ${hasStrategyPhase ? 'the strategy + trade-overlay nodes, ' : ''}), enter settings, draw every connection, then execute. Fully generated from ${CONFIG.src} by scripts/gen-pipeline.js.`,
    target: { selector: '.react-flow', aspect: '9:16', anchor: 'center' },
    setup,
    durationSec,
    holdAfterSec: 2.0,
    autoCamera: true,
    tracks: { input: combined.input, ...(combined.attention.length ? { attention: combined.attention } : {}) },
  }];
  // Chart reveal — shows the indicators plotted, with trade overlays from
  // PLOT.TRADES when the flow ran a backtest. Carries the outro narration.
  scenes.push({
    id: 'chart-reveal',
    description: `Reveal the chart with the plotted ${FLOW.toUpperCase()} result${hasStrategyPhase ? ' and trade overlays from PLOT.TRADES' : ''} after running the strategy.`,
    target: { selector: '#main-chart', aspect: '9:16', anchor: 'center' },
    setup: [{ at: 0.0, type: 'press', key: 'Digit1', shift: true }],
    durationSec: 6.0,
    holdAfterSec: 1.0,
    autoCamera: false,
    tracks: { input: [{ at: 1.4, type: 'drag', point: { x: 950, y: 540 }, to: { x: 1550, y: 540 } }] },
  });
  // Backtest Results overview — only when the flow actually ran a backtest.
  // Shift+5 = solo view of the result pane (PANE_KEYS[4]='result'); the
  // BacktestPanel defaults to the Overview tab so no extra clicks are needed.
  if (hasStrategyPhase) {
    scenes.push({
      id: 'backtest-overview',
      description: `Show the Backtest Results panel (Overview tab) with the hero metrics, verdict and equity sparkline for the ${FLOW.toUpperCase()} run.`,
      target: { selector: '[data-testid="backtest-panel"]', aspect: '9:16', anchor: 'center' },
      setup: [{ at: 0.0, type: 'press', key: 'Digit5', shift: true }],
      durationSec: 7.0,
      holdAfterSec: 1.0,
      autoCamera: false,
      tracks: { input: [] },
    });
  }
  const pipeline = {
    name: `${FLOW}-strategy-reel`,
    app: template.app,
    record: template.record,
    output: template.output,
    scenes,
  };
  writeFileSync(outPath, serialize(pipeline) + '\n');
  console.log(`wrote ${CONFIG.pipelineOut} (${scenes.length}-scene build${hasStrategyPhase ? ', with backtest phase' : ''})`);
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
