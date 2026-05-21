// Probe: find the selector for the EMA node's Length input so the recorder
// can click + type into it.
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
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  // Probe node id=3 (EMA 50)
  const node = document.querySelector('.react-flow__node[data-id="3"]');
  if (!node) return { error: 'node 3 not found' };
  // Find all inputs and textareas + classed elements that look like form controls
  const inputs = [...node.querySelectorAll('input, textarea, [contenteditable], [role="textbox"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      value: el.value !== undefined ? el.value : null,
      classes: el.className,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      // Get nearby label text
      nearby: (() => {
        let parent = el.parentElement;
        while (parent && parent !== node) {
          const t = parent.textContent.trim();
          if (t && t.length < 60) return t;
          parent = parent.parentElement;
        }
        return null;
      })(),
    };
  });
  // Also probe spans/divs that show values
  const valueLikeEls = [...node.querySelectorAll('span, div')].filter((el) => {
    const t = el.textContent.trim();
    return /^\d+$/.test(t) && el.children.length === 0;
  }).slice(0, 10).map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: el.textContent.trim(), classes: el.className, x: Math.round(r.x), y: Math.round(r.y) };
  });
  return { inputs, valueLikeEls, nodeHTML: node.outerHTML.slice(0, 4000) };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
