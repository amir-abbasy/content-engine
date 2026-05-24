// Generate BOTH artifacts for a flow in one shot: the build fixture and the
// pipeline. One name drives all derived paths (see scripts/lib/build-flow.js).
//
//   npm run gen            (default flow: ema)
//   npm run gen rsi        (a specific flow)

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'ema';

for (const script of ['scripts/gen-build.js', 'scripts/gen-pipeline.js']) {
  const res = spawnSync('node', [script, name], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) process.exit(res.status || 1);
}
