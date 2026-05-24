// Debug: print the camera keyframes buildAutoCamera emits for a flow's input
// track, so we can see zoom/anchor/group per keyframe without a live run.
import fs from 'node:fs';
import path from 'node:path';
import { buildAutoCamera } from '../src/lib/autocamera.js';
import { ROOT } from '../src/config.js';

const flow = process.argv[2] || 'macd';
const pipe = JSON.parse(fs.readFileSync(path.resolve(ROOT, `flows/${flow}/pipeline.json`), 'utf8'));
const scene = pipe.scenes[0];
const input = scene.tracks.input;
const az = pipe.record.autoZoom || {};
const cfg = {
  restZoom: az.restZoom, focusZoom: az.focusZoom, delayMs: az.delayMs,
  zoomMs: az.zoomMs, zoomOutMs: az.zoomOutMs, holdMs: az.holdMs,
  panMs: az.panMs, ease: az.ease,
};
// Tag indices the way record.js does (_idx) — autocamera uses indexOf so it's fine.
const kfs = buildAutoCamera(input, cfg);
console.log(`autoZoom: delay=${cfg.delayMs} zoom=${cfg.zoomMs} out=${cfg.zoomOutMs} hold=${cfg.holdMs} pan=${cfg.panMs}`);
console.log(`emitted ${kfs.length} keyframes:\n`);
for (const k of kfs) {
  const a = k.tAnchor;
  const ref = a ? `ref=${a.ref}(${(input[a.ref] && input[a.ref].type) || '?'})+${a.offsetMs}ms` : 'no-anchor';
  const tgt = k.selector ? k.selector.replace(/\.react-flow__/g, '.') : (k.framePair ? 'framePair' : (k.point ? 'point' : '?'));
  console.log(
    `at=${String(k.at).padStart(6)}  z=${String(k.zoom).padStart(4)}  seg=${k.seg ?? '-'}  fg=${(k.focusGroup ?? '-').padEnd(4)}  ${ref.padEnd(26)}  ${tgt}`
  );
}
