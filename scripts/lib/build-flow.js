// Shared transform: turn an app export (flows/complete-strategy.json) into the
// scene-3 BUILD model — used by both `gen-build.js` (writes the fixture) and
// `gen-pipeline.js` (writes the recording steps). Keeping it in one place means
// the fixture and the pipeline can NEVER drift out of sync: same node ids, same
// base/added split, same drag edges.
//
// Edit CONFIG here, then run `npm run gen` (build + pipeline) — never hand-edit
// flows/strategy-build.json or scene 3's input track.

import { readFileSync, existsSync } from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// One entry per strategy. Pick at run time with the STRATEGY env var
// (default "ema"): `STRATEGY=rsi npm run gen`. Each strategy is self-contained —
// its own export, fixture, and output pipeline — so they never collide.
//
//   mode: 'split'  — legacy: scene 1 builds the BASE nodes, gen-pipeline only
//                    regenerates a later "complete" scene (splices into pipelineOut).
//   mode: 'single' — the whole flow is built in ONE scene: every node added on
//                    camera, every edge dragged, configs shown. gen-pipeline
//                    writes a full standalone pipeline (pipelineOut).
export const STRATEGIES = {
  ema: {
    src: 'flows/complete-strategy.json',
    // legacy split build keeps its original file names
    out: 'flows/strategy-build.json',
    mode: 'split',
    pipelineOut: 'pipeline.json',
    sceneId: '03-complete-strategy',
    baseNodeKeys: ['ohlcv.data', 'ta.ema', 'plot'],
    reposition: {
      'np.greater':   { x: 2150, y: 120 },
      'np.less':      { x: 2150, y: 560 },
      'strategy.run': { x: 2580, y: 340 },
      'plot.trades':  { x: 3000, y: 340 },
    },
    addNodes: [
      {
        clone: 'np.greater', nodeKey: 'np.less', Name: 'Less Than',
        Description: 'Return the truth value of (x1 < x2) element-wise. Either operand may be a direct numeric value.',
        Example: { Code: 'np.less([1,2],[2,2])', Result: '[True, False]' },
      },
    ],
    extraDragEdges: [
      { source: '2', sourceHandle: 'output-0', target: '7', targetHandle: 'input-0' }, // EMA20 -> Less.x1
      { source: '3', sourceHandle: 'output-0', target: '7', targetHandle: 'input-1' }, // EMA50 -> Less.x2
      { source: '7', sourceHandle: 'output-0', target: '8', targetHandle: 'input-2' }, // Less.result -> Strategy.short_when
    ],
    searchOverrides: {},
  },

  rsi: {
    src: 'flows/flow-rsi.json',
    mode: 'single',
    sceneId: 'rsi-strategy',
    // single-scene: nothing is "base" — every node is added on camera and every
    // edge is dragged.
    baseNodeKeys: [],
    // Use the flow's own node positions (no override) — the layout was authored
    // in the app. Add { <id|nodeKey>: {x,y} } here to nudge specific nodes.
    reposition: {},
    addNodes: [],
    extraDragEdges: [],
    // Show each node's settings being entered on camera (numeric inputs + colors).
    configOnCamera: true,
    searchOverrides: {},
  },
};

// Resolve a strategy by name into a full config with DERIVED, fixed file paths
// (no timestamps): one name -> input export, build fixture, pipeline, output dir.
// Explicit paths in the strategy entry win (legacy ema keeps its old names).
export function getStrategy(name = 'ema') {
  let s = STRATEGIES[name];
  if (!s) {
    // Zero-config convention: drop flows/<name>.json (or flows/flow-<name>.json)
    // and `npm run flow <name>` just works — single-scene build, every node
    // added + wired on camera, configs entered, the flow's own layout. Add a
    // STRATEGIES entry only to override (legacy split mode, repositioning, etc.).
    const candidates = [`flows/${name}/flow.json`, `flows/${name}.json`, `flows/flow-${name}.json`];
    const src = candidates.find((p) => existsSync(path.resolve(ROOT, p)));
    if (!src) {
      throw new Error(`Unknown flow "${name}". Drop ${candidates.join(' or ')}, or add a STRATEGIES entry. Known: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    s = {
      src, mode: 'single', sceneId: `${name}-strategy`,
      baseNodeKeys: [], reposition: {}, addNodes: [], extraDragEdges: [],
      configOnCamera: true, searchOverrides: {},
    };
  }
  // All generated artifacts for a flow live under flows/<name>/ (build + pipeline),
  // its video under output/<name>/ — one folder per flow, no timestamps.
  return {
    name,
    ...s,
    out: s.out || `flows/${name}/build.json`,
    pipelineOut: s.pipelineOut || `flows/${name}/pipeline.json`,
    outDir: s.outDir || `output/${name}`,
  };
}

const byPos = (a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y);

// Build the scene model from a strategy config. Returns renumbered nodes
// (1..N), the baked base edges, the dragged edges, and the base/added id lists.
export function buildFlow(cfg = getStrategy()) {
  const flow = JSON.parse(readFileSync(path.resolve(ROOT, cfg.src), 'utf8'));

  // 1. dedupe nodes by id
  const seen = new Set();
  const nodes = flow.nodes.filter((n) => (seen.has(n.id) ? false : seen.add(n.id)));

  // 2. synthesize missing sibling nodes (clone + override)
  for (const spec of cfg.addNodes || []) {
    const base = nodes.find((n) => n.data.nodeKey === spec.clone);
    if (!base) { console.warn(`  ! clone source "${spec.clone}" not found — skipping ${spec.nodeKey}`); continue; }
    const clone = JSON.parse(JSON.stringify(base));
    clone.id = String(Math.max(...nodes.map((n) => +n.id)) + 1);
    clone.data.id = clone.id;
    clone.data.nodeKey = spec.nodeKey;
    if (spec.Name) clone.data.Name = spec.Name;
    if (spec.Description) clone.data.Description = spec.Description;
    if (spec.Example) clone.data.Example = spec.Example;
    if (spec.position) clone.position = spec.position;
    nodes.push(clone);
  }

  // 2b. force-place nodes for the video layout. Key by node id first (needed
  //     when several nodes share a nodeKey, e.g. two Plot Shape markers), then
  //     fall back to nodeKey.
  for (const n of nodes) {
    const p = cfg.reposition?.[n.id] ?? cfg.reposition?.[n.data.nodeKey];
    if (p) n.position = { ...p };
  }

  // 3. build order: BASE nodes first (scene 1's set), then added nodes — each
  //    group left-to-right. Keeps the base at ids 1..k and gives the new nodes
  //    the higher, stable ids the drags reference.
  const isBaseKey = (n) => cfg.baseNodeKeys.includes(n.data.nodeKey);
  const ordered = [
    ...nodes.filter(isBaseKey).sort(byPos),
    ...nodes.filter((n) => !isBaseKey(n)).sort(byPos),
  ];
  nodes.length = 0; nodes.push(...ordered);

  // 4. renumber ids 1..N so data-id == build position == injectFlow nodeCount
  const remap = {};
  nodes.forEach((n, i) => { remap[n.id] = String(i + 1); });
  nodes.forEach((n) => { n.id = remap[n.id]; n.data.id = n.id; });

  // 5. split edges: bake those among base-key nodes; the rest are drawn by drag
  const keyOf = (id) => nodes.find((n) => n.id === id)?.data.nodeKey;
  const isBase = (id) => cfg.baseNodeKeys.includes(keyOf(id));
  const remapEdge = (e) => ({ type: e.type || 'gradient', source: remap[e.source], sourceHandle: e.sourceHandle, target: remap[e.target], targetHandle: e.targetHandle });
  const baked = [];
  const dragged = [];
  const seenEdge = new Set(); // exports sometimes list the same edge twice
  const edgeKey = (e) => `${e.source}.${e.sourceHandle}->${e.target}.${e.targetHandle}`;
  for (const e of flow.edges || []) {
    const re = remapEdge(e);
    if (re.source == null || re.target == null) continue; // edge to a dropped node
    if (seenEdge.has(edgeKey(re))) continue;              // duplicate edge
    seenEdge.add(edgeKey(re));
    (isBase(re.source) && isBase(re.target) ? baked : dragged).push(re);
  }
  for (const e of cfg.extraDragEdges || []) {
    if (seenEdge.has(edgeKey(e))) continue;
    seenEdge.add(edgeKey(e));
    dragged.push({ type: 'gradient', ...e });
  }
  baked.forEach((e) => { e.id = `${e.source}${e.sourceHandle}-${e.target}${e.targetHandle}`; });

  const baseIds = nodes.filter(isBaseKey).map((n) => n.id);
  const addedIds = nodes.filter((n) => !isBaseKey(n)).map((n) => n.id);

  return { nodes, baked, dragged, baseIds, addedIds, remap };
}

// Port + node label helpers (for human-readable logging / search text).
export const nameOf = (nodes, id) => nodes.find((n) => n.id === id)?.data.Name;
export const portName = (nodes, id, h, kind) => {
  const n = nodes.find((x) => x.id === id);
  const arr = kind === 'out' ? n?.data.Outputs : n?.data.Inputs;
  return arr?.[+(h.split('-')[1])]?.name || h;
};

export { ROOT };
