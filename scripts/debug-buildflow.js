// Probe: does injecting the FULL flow once fit the view? If so, clearing +
// rebuilding progressively keeps that framing. Then test the hybrid build
// (right-click add shown + injectFlow snap) within the pre-fitted viewport.
import playwright from 'playwright';
import fs from 'node:fs';

const DBG = 'output/_debug';
fs.mkdirSync(DBG, { recursive: true });

const flow = JSON.parse(fs.readFileSync('flows/ema-plot.json', 'utf8'));
const slice = (count) => {
  const nodes = flow.nodes.slice(0, count);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: flow.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
};
const STEPS = [
  { search: 'ohlcv', pick: '[role="menuitem"]:has-text("Candles")' },
  { search: 'ta.ema', pick: '[role="menuitem"]' },
  { search: 'ta.ema', pick: '[role="menuitem"]' },
  { search: 'plot', pick: '[role="menuitem"]:has(:text-is("Plot"))' },
  { search: 'plot', pick: '[role="menuitem"]:has(:text-is("Plot"))' },
];

const log = (...a) => console.log(...a);
const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('  [pageerror]', e.message));
let shot = 0;
const snap = async (n) => { await page.screenshot({ path: `${DBG}/${String(++shot).padStart(2, '0')}-${n}.png` }); };
const nodeRects = () => page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node')].map((n) => {
    const r = n.getBoundingClientRect();
    return { id: n.getAttribute('data-id'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);
log('pyodide ready');

await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(800);
await page.evaluate(() => window.__ZUSTAND_STORE__?.getState()?.setAllNodesCollapsed(true));
await page.waitForTimeout(300);

// 1. inject FULL flow — does the view fit to it?
await page.evaluate((f) => window.__injectFlow(f), { nodes: flow.nodes, edges: flow.edges });
await page.waitForTimeout(1200);
log('  after inject FULL:', JSON.stringify(await nodeRects()));
await snap('A-full');

// 2. clear — does the viewport stay put?
await page.evaluate(() => window.__injectFlow({ nodes: [], edges: [] }));
await page.waitForTimeout(800);
await snap('B-cleared');

// 3. rebuild progressively (right-click add shown + injectFlow snap)
for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i];
  await page.locator('.react-flow__pane').first().click({ button: 'right', position: { x: 230, y: 320 } });
  await page.waitForTimeout(520);
  await page.fill('input[placeholder="Search nodes..."]', step.search);
  await page.waitForTimeout(620);
  await page.locator(step.pick).first().click();
  await page.waitForTimeout(650);
  await page.evaluate((f) => window.__injectFlow(f), slice(i + 1));
  await page.waitForTimeout(850);
  log(`  step ${i + 1}:`, JSON.stringify(await nodeRects()));
  await snap(`C-step-${i + 1}`);
}

await page.click('button[title="Execute flow"]');
await page.waitForTimeout(7000);
await snap('D-executed');
await page.keyboard.press('Shift+Digit1');
await page.waitForTimeout(3500);
await snap('E-chart');

await browser.close();
log('done — screenshots in', DBG);
