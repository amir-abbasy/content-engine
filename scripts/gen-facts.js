// gen-facts.js — Layer 0. Emits StrategyFacts.json: the set of TRUE things the
// AI planner is allowed to narrate from — the node graph distilled to its
// Semantic Anchor Table (semanticId -> execId + on-camera params) plus, when a
// flow actually backtests (has signal/order logic), real metrics.
//
// Pure + deterministic for the anchors. Metrics are optional: a plotting-only
// flow (e.g. MACD → Plot) has none, and the planner then narrates the result
// qualitatively rather than inventing numbers.
//
// Usage: node scripts/gen-facts.js <flow>     (e.g. macd)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFlow, getStrategy, semanticAnchors } from './lib/build-flow.js';

const flow = process.argv[2] || process.env.FLOW || 'macd';
const strat = getStrategy(flow);
const anchors = semanticAnchors(buildFlow(strat));

// A flow "backtests" only if it has signal/order logic — crossover/crossunder
// or comparison nodes feeding an order. Pure plotting flows have no metrics.
const SIGNAL_KEYS = new Set(['crossover', 'crossunder', 'np.greater', 'np.less']);
const hasSignals = anchors.some((a) => SIGNAL_KEYS.has(a.nodeKey));

const facts = {
  flow,
  generatedAt: new Date().toISOString(),
  anchors,
  // metrics are added by the probe run when a flow backtests; absent otherwise.
  ...(hasSignals ? { metrics: {} } : {}),
};

const outPath = path.resolve(ROOT, `flows/${flow}/facts.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(facts, null, 2) + '\n');
console.log(`wrote flows/${flow}/facts.json — ${anchors.length} anchors${hasSignals ? ', backtest flow (metrics via probe)' : ', plotting flow (no metrics)'}`);
for (const a of anchors) console.log(`  ${a.semanticId} (#${a.execId}) ${a.nodeKey}${Object.keys(a.params).length ? ' ' + JSON.stringify(a.params) : ''}`);
