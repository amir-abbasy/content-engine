// Defaults + CLI parsing for the recorder. Pipeline JSON values take precedence
// over these defaults; CLI flags take precedence over the pipeline.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const DEFAULTS = {
  app: {
    url: 'http://localhost:3000/',
    viewport: { width: 1920, height: 1080 },
    waitForPyodide: true,
    pyodideLoaderSelector: '.app-pyodide-loader',
    readySelector: undefined,
    readyTimeoutMs: 120000,
  },
  record: {
    browser: 'chromium',
    headless: false,
    timelineOffsetMs: 0,
    settleMs: 400,
    // Humanization: jittered timing + seeded reproducibility.
    humanize: {
      seed: 1,
      jitter: 0.15,
      scale: 1.0,
      preActionPause: [120, 280],
    },
    // Cursor personality: bezier travel with overshoot + hover hesitation.
    cursor: {
      movement: 'human',
      duration: [380, 720],
      overshoot: 0.12,
      hesitation: [70, 180],
      curvature: 0.4,
    },
    // Cinematic interaction engine: themed click + mark effects (see effects.js).
    // theme: a named theme, "random"/"auto" (one per video, seeded), or
    // "sequence" (rotate per scene). Default reproduces the original look.
    effects: {
      theme: 'gold-ripple',
      palette: undefined,
    },
  },
  output: {
    dir: 'output',
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    fitMode: 'cover',
    keepRaw: true,
  },
};

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const HELP = `
Content Engine — Phase 1 recorder

Usage:
  node src/record.js [pipeline.json] [options]

Options:
  --headed              Force a visible browser window
  --headless            Force a headless run
  --out <dir>           Override output directory
  --url <url>           Override the app URL
  --speed <n>           Playback speed-up applied to every clip (>=1)
  --max-total-sec <n>   Auto-derive a speed-up so the final video fits this many seconds
  s=<n> | --scene <n>   Record ONLY this scene (1-based index, or a scene id / id substring)
  flow=<name>           Record a named flow: uses its generated pipeline + fixed output/<name> dir
  skip-until=<n>        Seed nodes 1..n as already-built (via injectFlow nodeCount=n)
                        and strip their add/wire events from the input track — for fast
                        iteration on later nodes. Edges between seeded nodes are kept by
                        the seed; edges TO new nodes still draw on camera.
  -h, --help            Show this help

Env vars (override pipeline.json, are overridden by CLI flags):
  OUTPUT_SPEED          Same as --speed
  OUTPUT_MAX_TOTAL_SEC  Same as --max-total-sec
  FFMPEG_PATH / FFPROBE_PATH  Override ffmpeg/ffprobe binaries

Precedence: CLI flag > env var > pipeline.json > built-in default.
Defaults: pipeline = ./pipeline.json

Examples:
  npm run record              Record every scene
  npm run record s=3          Record only the 3rd scene
  npm run record s=03-complete-strategy   Record only that scene by id
`;

// Parse a numeric CLI/env value; returns undefined if absent or not a number.
export function numOpt(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCli(argv = process.argv.slice(2)) {
  const cli = {
    pipelinePath: 'pipeline.json', headless: undefined, outDir: undefined, url: undefined,
    speed: undefined, maxTotalSec: undefined, scene: undefined, flow: undefined,
    skipUntil: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--headed') {
      cli.headless = false;
    } else if (arg === '--headless') {
      cli.headless = true;
    } else if (arg === '--out') {
      cli.outDir = argv[++i];
    } else if (arg === '--url') {
      cli.url = argv[++i];
    } else if (arg === '--speed') {
      cli.speed = numOpt(argv[++i]);
    } else if (arg === '--max-total-sec') {
      cli.maxTotalSec = numOpt(argv[++i]);
    } else if (arg === '--scene' || arg === '-s') {
      cli.scene = argv[++i];
    } else if (/^(s|scene)=/.test(arg)) {
      cli.scene = arg.slice(arg.indexOf('=') + 1);
    } else if (arg === '--flow' || arg === '-f') {
      cli.flow = argv[++i];
    } else if (/^(f|flow)=/.test(arg)) {
      cli.flow = arg.slice(arg.indexOf('=') + 1);
    } else if (arg === '--skip-until') {
      cli.skipUntil = numOpt(argv[++i]);
    } else if (/^skip-until=/.test(arg)) {
      cli.skipUntil = numOpt(arg.slice(arg.indexOf('=') + 1));
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      cli.pipelinePath = arg;
    }
  }
  return cli;
}
