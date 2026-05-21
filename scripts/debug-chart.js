// Throwaway probe: inject + execute the EMA flow, switch to the chart pane,
// then dump #main-chart geometry so we can author a "pan into the past"
// camera move for scene 02.
import playwright from 'playwright';
import fs from 'node:fs';

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);
console.log('pyodide ready');

const flow = JSON.parse(fs.readFileSync('flows/ema-plot.json', 'utf8'));
await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(600);
await page.evaluate((f) => window.__injectFlow(f), flow);
await page.waitForTimeout(800);
await page.locator('button[title="Execute flow"]').click();
await page.waitForTimeout(7000);
await page.keyboard.press('Shift+Digit1');
await page.waitForTimeout(1500);

const geo = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    mainChart: pick('#main-chart'),
    canvases: [...document.querySelectorAll('#main-chart canvas')].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  };
});
console.log(JSON.stringify(geo, null, 2));
await page.screenshot({ path: 'output/_debug-chart.png' });
await browser.close();
console.log('done — output/_debug-chart.png');
