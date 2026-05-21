// More targeted probe: find the color swatch + the resulting picker popup.
import playwright from 'playwright';
import fs from 'node:fs';

const browser = await playwright.chromium.launch({ headless: false });
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

// Targeted: find swatches / elements whose background or style matches a hex color
const info1 = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node[data-id="4"]');
  if (!node) return { error: 'node 4 not found' };
  // Search for ANY element with style containing #facc15 or rgb(250
  const els = [...node.querySelectorAll('*')];
  const matches = els.filter((el) => {
    const s = el.getAttribute('style') || '';
    const cs = getComputedStyle(el).backgroundColor || '';
    return /#facc15/i.test(s) || /rgb\(250,\s*204,\s*21\)/.test(cs);
  }).slice(0, 12).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      classes: el.className.slice(0, 200),
      text: (el.textContent || '').trim().slice(0, 40),
      style: el.getAttribute('style')?.slice(0, 200),
      bgColor: getComputedStyle(el).backgroundColor,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
  });
  return { matches };
});
console.log('=== matches for plot node 4 color (#facc15) ===');
console.log(JSON.stringify(info1, null, 2));

// Try clicking the swatch — match by COMPUTED background color
const swatch = await page.evaluate(() => {
  const node = document.querySelector('.react-flow__node[data-id="4"]');
  const cand = [...node.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.backgroundColor === 'rgb(250, 204, 21)' && r.width > 6 && r.width < 60 && r.height > 6 && r.height < 60;
  });
  if (cand.length === 0) return null;
  const target = cand[0];
  const r = target.getBoundingClientRect();
  return {
    classes: target.className,
    style: target.getAttribute('style'),
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  };
});
console.log('=== swatch to click ===');
console.log(JSON.stringify(swatch, null, 2));

if (swatch) {
  await page.mouse.click(swatch.x, swatch.y);
  await page.waitForTimeout(1000);
  // Snapshot what appeared
  const popup = await page.evaluate(() => {
    const overlays = [...document.querySelectorAll('body > div, [role="dialog"], [class*="picker"], [class*="ColorPicker"], [class*="popup"], [class*="popover"]')];
    return overlays
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 80 && r.height > 80;
      })
      .slice(0, 4)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          classes: el.className.slice(0, 200),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          children: el.childElementCount,
          html: el.outerHTML.slice(0, 1500),
        };
      });
  });
  console.log('=== popup after clicking swatch ===');
  console.log(JSON.stringify(popup, null, 2));
  await page.screenshot({ path: 'output/_plot-color-picker.png' });
}

await browser.close();
console.log('done');
