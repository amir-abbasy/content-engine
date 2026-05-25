// Proof harness for the narration-driven pacing model (no render, no app).
// Joins: ContentPlan (lines) -> anchor table (actionRef -> execId) -> TTS
// estimate (line -> ms) -> per-node action budget (from the existing pipeline)
// -> pacing solver. Prints each beat's window + whether it's narration- or
// action-bound, and the resulting total duration.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildFlow, getStrategy, semanticAnchors } from '../scripts/lib/build-flow.js';
import { estimate } from '../src/lib/tts.js';
import { pace } from '../src/lib/pacing.js';

const flow = process.argv[2] || 'macd';
const plan = JSON.parse(fs.readFileSync(path.resolve(ROOT, `flows/${flow}/content-plan.json`), 'utf8'));
const pipe = JSON.parse(fs.readFileSync(path.resolve(ROOT, `flows/${flow}/pipeline.json`), 'utf8'));
const anchors = semanticAnchors(buildFlow(getStrategy(flow)));
const anchorOf = (id) => anchors.find((a) => a.semanticId === id);

// Per-node action budget = the span the node currently occupies in the input
// track: from its add right-click to the NEXT node's add (or the final Execute).
const input = pipe.scenes[0].tracks.input;
const rcs = input.filter((e) => e.type === 'rightClick' && e.addsNodeId != null);
const execClick = input.find((e) => e.type === 'click' && /Execute/i.test(e.selector || ''));
const budgetMs = {};
rcs.forEach((rc, i) => {
  const next = rcs[i + 1] ? rcs[i + 1].at : (execClick ? execClick.at : rc.at);
  budgetMs[String(rc.addsNodeId)] = Math.round((next - rc.at) * 1000);
});

// Build beats by resolving each ContentPlan segment to its node.
const beats = plan.build.voiceoverSegments.map((seg) => {
  const a = anchorOf(seg.actionRef);
  if (!a) throw new Error(`actionRef "${seg.actionRef}" does not resolve against the anchor table`);
  const tts = estimate(seg.line);
  return { ref: seg.actionRef, label: a.label, actionMs: budgetMs[a.execId] || 0, narrationMs: tts.durationMs, _line: seg.line };
});

const result = pace(beats);
console.log(`flow: ${flow}   beats: ${result.beats.length}   total: ${(result.totalMs / 1000).toFixed(1)}s\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('beat', 10), pad('action', 8), pad('voice', 8), pad('speed', 7), pad('window', 8), pad('hold', 7), 'bound');
for (const b of result.beats) {
  console.log(
    pad(b.ref, 10),
    pad((b.actionMs / 1000).toFixed(1) + 's', 8),
    pad((b.narrationMs / 1000).toFixed(1) + 's', 8),
    pad(b.speed + 'x', 7),
    pad((b.windowMs / 1000).toFixed(1) + 's', 8),
    pad((b.holdMs / 1000).toFixed(1) + 's', 7),
    b.bound,
  );
}
const actionBound = result.beats.filter((b) => b.bound === 'action').length;
const rawTotal = result.beats.reduce((s, b) => s + b.actionMs, 0) / 1000;
console.log(`\nraw (speed 1): ${rawTotal.toFixed(1)}s  ->  paced: ${(result.totalMs / 1000).toFixed(1)}s`);
if (actionBound) console.log(`${actionBound}/${result.beats.length} beats still action-bound at the ${3.0}x cap — bump those lines or raise the cap.`);
