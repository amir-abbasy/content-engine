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
  --headed            Force a visible browser window
  --headless          Force a headless run
  --out <dir>         Override output directory
  --url <url>         Override the app URL
  -h, --help          Show this help

Defaults: pipeline = ./pipeline.json
`;

export function parseCli(argv = process.argv.slice(2)) {
  const cli = { pipelinePath: 'pipeline.json', headless: undefined, outDir: undefined, url: undefined };
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
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      cli.pipelinePath = arg;
    }
  }
  return cli;
}
