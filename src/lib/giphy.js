// GIF source engine — finds emotion stickers/gifs on GIPHY and downloads one.
// Mirrors the tts.js provider shape: createGifSource() returns a reusable
// engine with search()/download()/close(), so one browser session serves every
// marker in a flow. No login or captcha is needed (confirmed against the live
// site) — results are public and a gif id resolves to a canonical download URL:
//
//   search page  ->  anchors  /gifs/<slug>-<ID>   +  CDN  /media/<ID>/...
//   download     ->  https://i.giphy.com/media/<ID>/giphy.{gif|webp|mp4}
//
// Stickers (giphy.com/stickers/search/<key>) carry transparency, so they
// composite cleanly as floating reactions over the video.
//
// provider: 'website' (scrape, default), 'api' (GIPHY_API_KEY, no browser),
//           'auto' (api when a key is present, else website).

import playwright from 'playwright';
import { log } from './log.js';

const slugify = (key) => String(key).trim().replace(/\s+/g, '-');
const searchUrl = (key, sticker) =>
  `https://giphy.com/${sticker ? 'stickers/' : ''}search/${encodeURIComponent(slugify(key)).replace(/%2D/gi, '-')}`;

// Canonical, login-free asset URL for a gif id.
export const assetUrl = (id, format = 'gif') => `https://i.giphy.com/media/${id}/giphy.${format}`;

// Pull the gif id (trailing token after the last '-') from a /gifs/ slug.
const idFromHref = (href) => {
  const path = (href || '').split('?')[0];
  if (!/\/(gifs|clips|stickers)\//.test(path)) return null;
  const m = /-([A-Za-z0-9]{6,})$/.exec(path) || /\/(?:gifs|clips|stickers)\/([A-Za-z0-9]{6,})$/.exec(path);
  return m ? m[1] : null;
};

function websiteSource({ headless }) {
  let browser = null;
  let context = null;
  let warnedSticker = false;

  const ensure = async () => {
    if (context) return;
    browser = await playwright.chromium.launch({ headless });
    context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  };

  return {
    engine: 'website',
    // NOTE: GIPHY's /stickers/search/ page serves a constant default grid to a
    // headless scraper (verified: identical results for unrelated queries), so
    // the website engine uses /search/ (GIFs) — which IS query-specific — and
    // returns OPAQUE gifs. For transparent stickers, use the API engine
    // (`--api` + GIPHY_API_KEY). A fresh page per search avoids SPA staleness.
    async search(key, { sticker = true, count = 25 } = {}) {
      await ensure();
      if (sticker && !warnedSticker) {
        warnedSticker = true;
        log.warn('  website engine returns OPAQUE gifs (query-specific); for transparent STICKERS run with --api + GIPHY_API_KEY');
      }
      const page = await context.newPage();
      try {
        await page.goto(searchUrl(key, false), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3500);
        const hrefs = await page.$$eval('a[href*="/gifs/"], a[href*="/clips/"]',
          (as) => as.map((a) => a.getAttribute('href')).filter(Boolean)).catch(() => []);
        const ids = [];
        const seen = new Set();
        for (const h of hrefs) {
          const id = idFromHref(h);
          if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
          if (ids.length >= count) break;
        }
        return ids.map((id) => ({ id, sourceUrl: `https://giphy.com/gifs/${id}` }));
      } finally {
        await page.close().catch(() => {});
      }
    },
    async download({ id }, { format = 'gif', outPath } = {}) {
      await ensure();
      const url = assetUrl(id, format);
      const resp = await context.request.get(url);
      if (!resp.ok()) throw new Error(`download ${url} → HTTP ${resp.status()}`);
      const buffer = await resp.body();
      if (!buffer || buffer.length < 200) throw new Error(`download ${url} returned ${buffer ? buffer.length : 0} bytes`);
      const fs = await import('node:fs');
      if (outPath) fs.writeFileSync(outPath, buffer);
      return { path: outPath || null, ext: format, bytes: buffer.length, sourceUrl: url, buffer };
    },
    async close() {
      try { if (context) await context.close(); } catch {}
      try { if (browser) await browser.close(); } catch {}
    },
  };
}

function apiSource({ apiKey }) {
  const fetchJson = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`GIPHY API ${r.status}`);
    return r.json();
  };
  return {
    engine: 'api',
    async search(key, { sticker = true, count = 25 } = {}) {
      const kind = sticker ? 'stickers' : 'gifs';
      const u = `https://api.giphy.com/v1/${kind}/search?api_key=${apiKey}&q=${encodeURIComponent(key)}&limit=${count}&rating=pg-13&bundle=messaging_non_clips`;
      const j = await fetchJson(u);
      return (j.data || []).map((g) => ({ id: g.id, sourceUrl: g.url }));
    },
    async download({ id }, { format = 'gif', outPath } = {}) {
      const url = assetUrl(id, format);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download ${url} → HTTP ${r.status}`);
      const buffer = Buffer.from(await r.arrayBuffer());
      const fs = await import('node:fs');
      if (outPath) fs.writeFileSync(outPath, buffer);
      return { path: outPath || null, ext: format, bytes: buffer.length, sourceUrl: url, buffer };
    },
    async close() {},
  };
}

export function createGifSource({ provider = 'auto', apiKey = process.env.GIPHY_API_KEY, headless = true } = {}) {
  const useApi = provider === 'api' || (provider === 'auto' && apiKey);
  if (useApi && !apiKey) throw new Error('provider "api" needs GIPHY_API_KEY');
  const src = useApi ? apiSource({ apiKey }) : websiteSource({ headless });
  log.info(`  gif engine: ${src.engine}`);
  return src;
}
