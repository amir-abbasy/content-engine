// Probe: does the target app's __injectFlow refit the viewport, and what
// hooks are exposed for locking the viewport transform?
import playwright from 'playwright';
import fs from 'node:fs';

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
try { await page.waitForSelector('.app-pyodide-loader', { state: 'visible', timeout: 4000 }); } catch {}
await page.waitForSelector('.app-pyodide-loader', { state: 'detached', timeout: 120000 });
await page.waitForTimeout(800);

await page.keyboard.press('Shift+Digit2');
await page.waitForTimeout(600);

const flow = JSON.parse(fs.readFileSync('flows/ema-plot.json', 'utf8'));

const probe = async (label) => {
  const data = await page.evaluate(() => {
    const out = {};
    if (typeof window.__getFlowData === 'function') {
      out.flowData = window.__getFlowData();
    }
    if (window.__ZUSTAND_STORE__) {
      try {
        const s = window.__ZUSTAND_STORE__.getState();
        out.zustandKeys = Object.keys(s).filter((k) => typeof s[k] !== 'function');
        out.viewport = s.viewport ?? s.flowViewport ?? null;
        out.transform = s.transform ?? null;
      } catch (e) { out.zustandErr = String(e); }
    }
    out.windowFns = Object.keys(window).filter((k) => k.startsWith('__'));
    // Capture node bounding boxes in viewport coords
    out.nodes = [...document.querySelectorAll('.react-flow__node')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-id'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    // Inspect the viewport pane transform (this is where React Flow stores its pan/zoom CSS)
    const vp = document.querySelector('.react-flow__viewport');
    out.viewportTransform = vp ? vp.style.transform : null;
    return out;
  });
  console.log(`\n=== ${label} ===`);
  console.log('windowFns:', data.windowFns);
  console.log('viewportTransform:', data.viewportTransform);
  console.log('zustandKeys:', data.zustandKeys);
  console.log('viewport:', data.viewport);
  console.log('transform:', data.transform);
  console.log('nodes:', data.nodes);
};

await page.evaluate((f) => window.__injectFlow(f), flow);
await page.waitForTimeout(1500);
await probe('after inject full');

await page.evaluate((f) => window.__injectFlow(f), { nodes: [], edges: [] });
await page.waitForTimeout(600);
await probe('after clear');

for (let n = 1; n <= 5; n++) {
  const nodes = flow.nodes.slice(0, n);
  const ids = new Set(nodes.map((x) => x.id));
  const edges = (flow.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target));
  await page.evaluate(({ ns, es }) => window.__injectFlow({ nodes: ns, edges: es }), { ns: nodes, es: edges });
  await page.waitForTimeout(700);
  await probe(`after inject nodeCount:${n}`);
}

await browser.close();
