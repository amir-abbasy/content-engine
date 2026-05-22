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
  -h, --help            Show this help

Env vars (override pipeline.json, are overridden by CLI flags):
  OUTPUT_SPEED          Same as --speed
  OUTPUT_MAX_TOTAL_SEC  Same as --max-total-sec
  FFMPEG_PATH / FFPROBE_PATH  Override ffmpeg/ffprobe binaries

Precedence: CLI flag > env var > pipeline.json > built-in default.
Defaults: pipeline = ./pipeline.json
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
    speed: undefined, maxTotalSec: undefined,
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
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      cli.pipelinePath = arg;
    }
  }
  return cli;
}
