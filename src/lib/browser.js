// Browser lifecycle: launch the recording context, open the app, and block
// until Pyodide has finished loading.
//
// Recording model: Playwright records video per *context*, for the whole
// context lifetime. We therefore record ONE continuous session and slice it
// per-scene afterwards (see crop.js). `recordingStartedAt` is the wall-clock
// anchor scene timestamps are measured against.

import playwright from 'playwright';
import { log } from './log.js';

export async function launchRecorder({ pipeline, rawDir, headless }) {
  const browserType = playwright[pipeline.record.browser] || playwright.chromium;
  const { viewport } = pipeline.app;

  log.step(`Launching ${pipeline.record.browser} (headless: ${headless})`);
  const browser = await browserType.launch({ headless });

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: viewport },
  });

  const page = await context.newPage();
  // Anchor the scene timeline as close as possible to video t0 (first page).
  const recordingStartedAt = Date.now();

  log.step(`Opening ${pipeline.app.url}`);
  await page.goto(pipeline.app.url, { waitUntil: 'domcontentloaded' });

  return { browser, context, page, recordingStartedAt };
}

// The app renders `pipeline.app.pyodideLoaderSelector` only while
// `pyodideReady === 'loading'`, then unmounts it. So: optionally see it appear,
// then wait for it to detach. If it never appears, Pyodide was likely already
// warm — we don't fail, just move on.
export async function waitForPyodide(page, app) {
  if (!app.waitForPyodide) {
    log.warn('waitForPyodide disabled — starting scenes immediately');
    return;
  }

  const sel = app.pyodideLoaderSelector;
  log.step(`Waiting for Pyodide (loader: ${sel})`);

  let sawLoader = false;
  try {
    await page.waitForSelector(sel, { state: 'visible', timeout: 4000 });
    sawLoader = true;
  } catch {
    // Loader never showed within the grace window — may already be done.
  }

  try {
    await page.waitForSelector(sel, { state: 'detached', timeout: app.readyTimeoutMs });
    log.ok(sawLoader ? 'Pyodide finished loading' : 'Pyodide loader not present — assuming ready');
  } catch {
    throw new Error(`Pyodide did not finish within ${app.readyTimeoutMs}ms (loader "${sel}" still present)`);
  }

  if (app.readySelector) {
    log.step(`Waiting for ready selector: ${app.readySelector}`);
    await page.waitForSelector(app.readySelector, { state: 'visible', timeout: app.readyTimeoutMs });
  }

  // One extra paint settle so scene 1's first frame isn't mid-transition.
  await page.waitForTimeout(500);
}
