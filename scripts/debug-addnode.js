// Throwaway probe: walk the right-click -> search -> add-node sequence with a
// screenshot + DOM dump after every step, to find where it breaks.
import playwright from 'playwright';
import fs from 'node:fs';

const DBG = 'output/_debug';
fs.rmSync(DBG, { recursive: true, force: true });
fs.mkdirSync(DBG, { recursive: true });

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => console.log('  [page]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);
console.log('pyodide ready');

await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(800);

const paneBox = await page.locator('.react-flow__pane').first().boundingBox();
console.log('pane box:', JSON.stringify(paneBox));

// --- step 1: right-click the pane ---
await page.locator('.react-flow__pane').first().click({ button: 'right', position: { x: 1500, y: 430 } });
await page.waitForTimeout(900);
await page.screenshot({ path: `${DBG}/1-after-rightclick.png` });
console.log('1 after right-click:', JSON.stringify(await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="Search nodes..."]');
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  return {
    hasSearchInput: !!input,
    roleMenu: !!document.querySelector('[role="menu"]'),
    menuItemCount: items.length,
    menuItemTexts: items.slice(0, 12).map((i) => i.textContent.trim()),
  };
})));

// --- step 2: fill the search box ---
const hasInput = await page.locator('input[placeholder="Search nodes..."]').count();
if (hasInput) {
  await page.fill('input[placeholder="Search nodes..."]', 'ohlcv');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${DBG}/2-after-fill.png` });
  console.log('2 after fill:', JSON.stringify(await page.evaluate(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    return { menuItemCount: items.length, texts: items.map((i) => i.textContent.trim()) };
  })));

  // --- step 3: click the Candles result ---
  const candles = page.locator('[role="menuitem"]', { hasText: 'Candles' });
  console.log('3 candles menuitem matches:', await candles.count());
  if (await candles.count()) {
    await candles.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DBG}/3-after-click.png` });
  }
} else {
  console.log('2 SKIPPED — no search input found');
}

// --- final flow state ---
console.log('4 FLOW STATE:', JSON.stringify(await page.evaluate(() => {
  const fd = window.__getFlowData ? window.__getFlowData() : null;
  const domNodes = [...document.querySelectorAll('.react-flow__node')].map((n) => {
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: n.textContent.slice(0, 40) };
  });
  return { flowDataNodes: fd ? fd.nodes.length : 'NO __getFlowData HOOK', domNodeCount: domNodes.length, domNodes };
}), null, 2));
await page.screenshot({ path: `${DBG}/4-final.png` });

await browser.close();
console.log('done — screenshots in', DBG);
