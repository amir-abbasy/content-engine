// Loads a pipeline JSON file, merges it over DEFAULTS, and validates the parts
// the recorder relies on. Validation is intentionally hand-rolled (no schema
// library) so the only runtime dependency stays Playwright. pipeline.schema.json
// is the authoritative, fully-documented contract.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../config.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep-merge plain objects; arrays and scalars from `override` win wholesale.
function merge(base, override) {
  if (!isObj(base) || !isObj(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

const TARGET_KEYS = ['selector', 'pane', 'paneIndex', 'region', 'fullViewport'];

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
  const hasActions = Array.isArray(scene.actions) && scene.actions.length > 0;
  if (scene.durationMs === undefined && !scene.stopWhen && !scene.holdAfterMs && !hasActions) {
    throw new Error(`${where} (id "${scene.id}") needs "durationMs", "stopWhen", "holdAfterMs", or "actions"`);
  }
  if (scene.stopWhen && !scene.stopWhen.selector) {
    throw new Error(`${where}.stopWhen needs a "selector"`);
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

  const pipeline = {
    name: raw.name || path.basename(abs, '.json'),
    app: merge(DEFAULTS.app, raw.app || {}),
    record: merge(DEFAULTS.record, raw.record || {}),
    output: merge(DEFAULTS.output, raw.output || {}),
    scenes: raw.scenes,
    _path: abs,
  };

  return pipeline;
}
