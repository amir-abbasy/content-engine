// One command, one flow name: (re)generate the build fixture + pipeline, then
// record it into output/<name>. This is the turnkey path for a new strategy.
//
//   npm run flow rsi                 generate + record the RSI flow
//   npm run flow rsi --headed        pass extra args through to the recorder
//   npm run flow rsi s=1             (e.g. a scene filter)
//
// Input export, build fixture, pipeline, and output dir are all derived from the
// name (no timestamps) — see scripts/lib/build-flow.js.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [name, ...extra] = process.argv.slice(2);
if (!name) {
  console.error('usage: npm run flow <name> [-- recorder args]');
  process.exit(1);
}

const run = (script, args) => {
  const res = spawnSync('node', [script, ...args], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) process.exit(res.status || 1);
};

run('scripts/gen-build.js', [name]);
run('scripts/gen-pipeline.js', [name]);
run('src/record.js', ['--flow', name, ...extra]);
