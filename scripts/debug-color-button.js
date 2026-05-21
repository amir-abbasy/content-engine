// Find the clickable color-swatch BUTTON in the Plot node (the one that opens
// the color picker popover when clicked). The swatch div lives inside it.
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

const found = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node[data-id="4"]');
  const swatchDiv = [...node.querySelectorAll('*')].find((el) => {
    return getComputedStyle(el).backgroundColor === 'rgb(250, 204, 21)' && el.getBoundingClientRect().width < 60;
  });
  if (!swatchDiv) return { error: 'swatch not found' };
  // Walk up to find the nearest clickable ancestor (button / role=button / element with cursor:pointer)
  let p = swatchDiv;
  const trail = [];
  while (p && p !== node) {
    trail.push({
      tag: p.tagName.toLowerCase(),
      role: p.getAttribute('role'),
      title: p.getAttribute('title'),
      ariaHasPopup: p.getAttribute('aria-haspopup'),
      classes: (p.className || '').slice(0, 200),
      text: (p.textContent || '').trim().slice(0, 60),
      cursor: getComputedStyle(p).cursor,
    });
    if (p.tagName === 'BUTTON' || p.getAttribute('role') === 'button') break;
    p = p.parentElement;
  }
  return { trail };
});

console.log(JSON.stringify(found, null, 2));
await browser.close();
