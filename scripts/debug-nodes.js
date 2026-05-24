// Probe: discover node search terms + handle structure for NEW nodes (strategy
// / backtest run, condition greater-than / less-than) so scene 3 can wire them
// up precisely instead of guessing. Run with the app on localhost:3000:
//
//   node scripts/debug-nodes.js                       # default term list
//   node scripts/debug-nodes.js strategy greater less # custom terms
//
// Prints, per search term: the menu items that match. Then ADDS each node it
// finds and dumps its React Flow handles (data-handleid + side + the row label
// next to each), e.g. which input handle is "Long when" / "Short when".
import playwright from 'playwright';
import fs from 'node:fs';

const TERMS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['strategy', 'backtest', 'run', 'greater', 'less', 'condition', 'crossover', 'compare'];

const DBG = 'output/_debug-nodes';
fs.mkdirSync(DBG, { recursive: true });
const log = (...a) => console.log(...a);

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('  [pageerror]', e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);
log('pyodide ready\n');

// Dump every matching menu item for a search term.
async function search(term) {
  await page.locator('.react-flow__pane').first().click({ button: 'right', position: { x: 700, y: 400 } });
  await page.waitForTimeout(400);
  await page.fill('input[placeholder="Search nodes..."]', term);
  await page.waitForTimeout(500);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  log(`search "${term}" -> ${items.length} result(s):`);
  items.forEach((t) => log('   •', t));
  return items;
}

// Add the first menu item that contains `label`, then dump the new node's handles.
async function addAndDumpHandles(term, label) {
  await page.evaluate(() => window.__injectFlow({ nodes: [], edges: [] })); // clear
  await page.waitForTimeout(400);
  await page.locator('.react-flow__pane').first().click({ button: 'right', position: { x: 700, y: 400 } });
  await page.waitForTimeout(400);
  await page.fill('input[placeholder="Search nodes..."]', term);
  await page.waitForTimeout(500);
  const pick = page.locator(`[role="menuitem"]:has-text("${label}")`).first();
  if (!(await pick.count())) { log(`  (no menu item matching "${label}")`); return; }
  await pick.click();
  await page.waitForTimeout(800);
  const dump = await page.evaluate(() => {
    const node = document.querySelector('.react-flow__node');
    if (!node) return null;
    const handles = [...node.querySelectorAll('.react-flow__handle')].map((h) => {
      const r = h.getBoundingClientRect();
      // best-effort label: nearest row element's text on the same Y band
      let label = '';
      const rows = [...node.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim());
      let best = Infinity;
      for (const e of rows) {
        const er = e.getBoundingClientRect();
        const dy = Math.abs((er.top + er.height / 2) - (r.top + r.height / 2));
        if (dy < best && dy < 18) { best = dy; label = e.textContent.trim(); }
      }
      return {
        handleid: h.getAttribute('data-handleid') || h.getAttribute('data-id'),
        side: h.classList.contains('react-flow__handle-left') ? 'target/input'
            : h.classList.contains('react-flow__handle-right') ? 'source/output' : '?',
        y: Math.round(r.top), label,
      };
    }).sort((a, b) => a.y - b.y);
    return { id: node.getAttribute('data-id'), text: node.innerText.replace(/\s+/g, ' ').trim().slice(0, 200), handles };
  });
  log(`\n  handles for "${label}" (node ${dump?.id}):`);
  log('   node text:', dump?.text);
  (dump?.handles || []).forEach((h) => log(`     [${h.side}] ${h.handleid}  <- "${h.label}"`));
}

for (const t of TERMS) { await search(t); log(''); }

// Customise these once the searches above reveal the real labels:
log('\n=== HANDLE DUMPS (edit labels in the script if these miss) ===');
await addAndDumpHandles('strategy', 'Strategy');
await addAndDumpHandles('greater', 'Greater');
await addAndDumpHandles('less', 'Less');

await page.screenshot({ path: `${DBG}/nodes.png` });
await browser.close();
log('\ndone — screenshot at', `${DBG}/nodes.png`);
