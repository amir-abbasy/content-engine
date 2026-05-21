// Loads a pipeline JSON file, merges it over DEFAULTS, and validates that the
// scenes carry enough timing data for the scheduler to run. Validation is
// hand-rolled (no schema library) so the only runtime dependency stays
// Playwright. pipeline.schema.json is the authoritative, fully-documented
// contract — keep these two in sync.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../config.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, override) {
  if (!isObj(base) || !isObj(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const TARGET_KEYS = ['selector', 'pane', 'paneIndex', 'region', 'fullViewport'];
const KNOWN_TRACKS = new Set(['input', 'camera', 'reveal', 'attention']);

function validateEvent(ev, where) {
  if (!isObj(ev)) throw new Error(`${where} must be an object`);
  if (ev.at !== undefined && typeof ev.at !== 'number') {
    throw new Error(`${where}.at must be a number (seconds)`);
  }
}

function validateTracks(scene, i) {
  const where = `scenes[${i}] (id "${scene.id}")`;
  if (!scene.tracks) return;
  if (!isObj(scene.tracks)) throw new Error(`${where}.tracks must be an object`);
  for (const [name, list] of Object.entries(scene.tracks)) {
    if (!KNOWN_TRACKS.has(name)) {
      throw new Error(`${where}.tracks.${name} is not a known track (input, camera, reveal, attention)`);
    }
    if (!Array.isArray(list)) {
      throw new Error(`${where}.tracks.${name} must be an array`);
    }
    list.forEach((ev, j) => validateEvent(ev, `${where}.tracks.${name}[${j}]`));
  }
}

function validateScene(scene, i) {
  const where = `scenes[${i}]`;
  if (!isObj(scene)) throw new Error(`${where} must be an object`);
  if (!scene.id || typeof scene.id !== 'string') {
    throw new Error(`${where}.id is required and must be a string`);
  }
  if (!scene.target || !isObj(scene.target)) {
    throw new Error(`${where} (id "${scene.id}") needs a "target"`);
  }
  const used = TARGET_KEYS.filter((k) => scene.target[k] !== undefined);
  if (used.length === 0) {
    throw new Error(`${where} target needs one of: ${TARGET_KEYS.join(', ')}`);
  }
  if (used.length > 1) {
    throw new Error(`${where} target has conflicting keys (${used.join(', ')}); use exactly one`);
  }
  if (scene.durationSec !== undefined && typeof scene.durationSec !== 'number') {
    throw new Error(`${where}.durationSec must be a number (seconds)`);
  }
  if (scene.setup !== undefined && !Array.isArray(scene.setup)) {
    throw new Error(`${where}.setup must be an array of events`);
  }
  if (Array.isArray(scene.setup)) {
    scene.setup.forEach((ev, j) => validateEvent(ev, `${where}.setup[${j}]`));
  }
  validateTracks(scene, i);

  const hasTimeline = Array.isArray(scene.setup) && scene.setup.length > 0
    || (scene.tracks && Object.values(scene.tracks).some((list) => Array.isArray(list) && list.length > 0))
    || scene.durationSec !== undefined
    || scene.holdAfterSec !== undefined;
  if (!hasTimeline) {
    throw new Error(`${where} (id "${scene.id}") needs "tracks", "setup", "durationSec", or "holdAfterSec"`);
  }
}

export function loadPipeline(pipelinePath) {
  const abs = path.resolve(pipelinePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Pipeline file not found: ${abs}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Pipeline JSON is invalid (${abs}): ${err.message}`);
  }

  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error('Pipeline must define a non-empty "scenes" array');
  }

  const ids = new Set();
  raw.scenes.forEach((scene, i) => {
    validateScene(scene, i);
    if (ids.has(scene.id)) throw new Error(`Duplicate scene id: "${scene.id}"`);
    ids.add(scene.id);
  });

  return {
    name: raw.name || path.basename(abs, '.json'),
    app: merge(DEFAULTS.app, raw.app || {}),
    record: merge(DEFAULTS.record, raw.record || {}),
    output: merge(DEFAULTS.output, raw.output || {}),
    scenes: raw.scenes,
    _path: abs,
  };
}
