// Dump what color-button titles + which inputs exist in the open color picker.
import playwright from 'playwright';
import fs from 'node:fs';

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);

const flow = JSON.parse(fs.readFileSync('flows/ema-plot.json', 'utf8'));
await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(600);
await page.evaluate((f) => window.__injectFlow(f), flow);
await page.waitForTimeout(1000);

// Click the swatch on Plot 1
await page.locator('.react-flow__node[data-id="4"]').first().click({ position: { x: 14, y: 131 } });
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return { error: 'no dialog' };
  const buttons = [...dlg.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
  const inputs = [...dlg.querySelectorAll('input')].map((i) => ({
    type: i.type,
    placeholder: i.placeholder,
    value: i.value,
    classes: i.className.slice(0, 120),
  }));
  return { buttons, inputs };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
