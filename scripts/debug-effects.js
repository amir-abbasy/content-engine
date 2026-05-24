// Headless smoke test for the cinematic interaction engine: installs the
// effects init script, then exercises every click + mark effect across all
// themes against a blank page, asserting no page-level exceptions are thrown
// and that elements are created + cleaned up. Run: node scripts/debug-effects.js
import playwright from 'playwright';
import { effectsInitScript, resolveEffects, FX_THEMES } from '../src/lib/effects.js';

const cfg = resolveEffects({ effects: { theme: 'sequence' } }, () => 0.5);
const browser = await playwright.chromium.launch({ headless: false });
const ctx = await browser.newContext();
const errors = [];
await ctx.addInitScript(effectsInitScript, cfg);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('data:text/html,<body style="background:#111"></body>');

console.log('has __fx:', await page.evaluate(() => !!window.__fx));
console.log('start theme:', await page.evaluate(() => window.__fx.theme));

const results = [];
for (const t of FX_THEMES) {
  await page.evaluate((n) => window.__fx.setTheme(n), t.name);
  await page.evaluate(() => window.__fx.click(400, 300, {}));
  await page.evaluate(() => window.__fx.mark({ left: 300, top: 200, width: 200, height: 120 }, {}));
  const cnt = await page.evaluate(() => document.querySelectorAll('#__fx-layer .__fx').length);
  const core = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fx-core').trim());
  results.push(`${t.name.padEnd(14)} ${String(cnt).padStart(3)} els  core=${core}`);
}
console.log(results.join('\n'));

// real mousedown should auto-fire the active click effect
await page.mouse.click(500, 400);
console.log('after mouse click, els:', await page.evaluate(() => document.querySelectorAll('#__fx-layer .__fx').length));

await page.waitForTimeout(1700);
console.log('els after settle (expect 0):', await page.evaluate(() => document.querySelectorAll('#__fx-layer .__fx').length));
console.log('pageerrors:', errors.length ? errors.join(' | ') : 'none');

await browser.close();
process.exit(errors.length ? 1 : 0);
