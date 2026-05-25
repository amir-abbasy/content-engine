// Throwaway probe: open giphy.com/search/<key> and report whether results are
// scrapeable without login/captcha, and how to extract a downloadable gif URL.
// Run: node scripts/debug-giphy.js [search-key]
import playwright from 'playwright';

const key = (process.argv[2] || 'money').replace(/\s+/g, '-');
const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

const mediaUrls = new Set();
page.on('response', (r) => {
  const u = r.url();
  if (/(media|i)\d*\.giphy\.com\/media\//.test(u) && /\.(gif|webp|mp4)(\?|$)/.test(u)) mediaUrls.add(u.split('?')[0]);
});

const out = {};
try {
  await page.goto(`https://giphy.com/search/${key}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  out.title = await page.title();
  out.url = page.url();
  out.loginWall = /log ?in|sign ?up/i.test(await page.locator('body').innerText().catch(() => '')) ? 'text present (may be header only)' : 'none obvious';

  // Anchors to individual gifs carry the id as the last "-<id>" token of the slug.
  out.gifAnchors = await page.$$eval('a[href*="/gifs/"], a[href*="/clips/"], a[href*="/stickers/"]', (as) =>
    as.map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 8));
  // <img>/<video> media srcs on the giphy CDN.
  out.imgSrcs = await page.$$eval('img, source, video', (els) =>
    els.map((e) => e.currentSrc || e.src || e.getAttribute('src') || '').filter((s) => /giphy\.com\/media\//.test(s)).slice(0, 8));

  // Derive a canonical download URL from the first gif id we can find.
  const idFrom = (s) => {
    let m = /\/media\/([A-Za-z0-9]+)\//.exec(s);
    if (m) return m[1];
    m = /-([A-Za-z0-9]{8,})(?:$|\?)/.exec(s);
    return m ? m[1] : null;
  };
  const firstId = idFrom(out.imgSrcs[0] || '') || idFrom(out.gifAnchors[0] || '');
  out.firstId = firstId;
  out.canonicalGif = firstId ? `https://i.giphy.com/media/${firstId}/giphy.gif` : null;
  out.canonicalMp4 = firstId ? `https://i.giphy.com/media/${firstId}/giphy.mp4` : null;

  out.mediaUrlsSeen = [...mediaUrls].slice(0, 10);
} catch (e) {
  out.fatal = e.message;
} finally {
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
