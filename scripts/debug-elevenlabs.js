// Throwaway probe #3: robustly pick "Alex" (search-filter the picker, then click
// the role=option), confirm the trigger shows Alex, click Play, and capture how
// the audio is delivered. Screenshots into output/_vo-debug/.
import fs from 'node:fs';
import path from 'node:path';
import playwright from 'playwright';

const OUT = path.resolve('output/_vo-debug');
fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name) => { try { await page.screenshot({ path: path.join(OUT, name + '.png') }); } catch {} };

const SEL = {
  textarea: 'textarea[aria-label="Enter your text here, ElevenLabs AI Voice Generator will read it for you"]',
  voiceButton: '[aria-label="Voice"]',
  voiceList: '[data-trigger="Select"]',
  play: '[aria-label="Play"]',
};

const browser = await playwright.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

const net = [];
const STATIC = /\.(png|jpe?g|svg|gif|webp|woff2?|ttf|css|ico|js|mjs)(\?|$)/i;
page.on('response', (r) => {
  const url = r.url();
  if (STATIC.test(url) || /bing|google|posthog|sentry|segment|analytics|cloudflareinsights/i.test(url)) return;
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  net.push({ t: Date.now(), method: r.request().method(), status: r.status(), type: r.request().resourceType(), ct, url: url.slice(0, 130) });
});

const out = {};
try {
  await page.goto('https://elevenlabs.io/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  for (const name of [/accept all/i, /allow all/i, /^accept$/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 1500 }).catch(() => {}); break; }
  }

  await page.locator(SEL.textarea).click({ timeout: 5000 });
  await page.locator(SEL.textarea).fill('Testing the ElevenLabs voiceover capture pipeline.');

  // open voice picker
  await page.click(SEL.voiceButton, { timeout: 5000 });
  await page.waitForTimeout(900);
  await shot(page, '20-voice-open');

  // is there a search box in the popover?
  const search = page.locator('input[type="search"], input[placeholder*="Search" i], [data-trigger="Select"] input, [role="dialog"] input').first();
  out.hasSearch = await search.count().catch(() => 0);
  if (out.hasSearch) { await search.fill('Alex').catch(() => {}); await page.waitForTimeout(700); await shot(page, '21-search-alex'); }

  // click the option named exactly "Alex"
  let opt = page.getByRole('option', { name: 'Alex', exact: true }).first();
  if (!(await opt.count().catch(() => 0))) {
    // fallback: the option div ancestor of the exact-text node
    opt = page.locator('[role="option"]').filter({ has: page.getByText('Alex', { exact: true }) }).first();
  }
  out.optCount = await opt.count().catch(() => 0);
  if (out.optCount) {
    await opt.scrollIntoViewIfNeeded().catch(() => {});
    await opt.click({ timeout: 6000 }).catch(async (e) => {
      out.optClickErr = e.message.split('\n')[0];
      await opt.click({ timeout: 3000, force: true }).catch((e2) => out.optForceErr = e2.message.split('\n')[0]);
    });
  }
  await page.waitForTimeout(900);
  await shot(page, '22-alex-picked');

  // confirm: voice trigger label + dropdown closed
  out.voiceTriggerText = (await page.locator(SEL.voiceButton).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  out.dropdownStillOpen = await page.locator(SEL.voiceList).isVisible().catch(() => false);
  out.playLabelBefore = await page.locator(SEL.play).first().getAttribute('aria-label').catch(() => null);

  // Play + capture
  const mark = Date.now();
  await page.click(SEL.play, { timeout: 6000 }).catch((e) => out.playClickErr = e.message.split('\n')[0]);
  await page.waitForTimeout(16000);
  await shot(page, '23-after-play');
  out.playLabelAfter = await page.locator(SEL.play).first().getAttribute('aria-label').catch(() => null);
  out.mediaEls = await page.evaluate(() => [...document.querySelectorAll('audio,video')].map((m) => ({ tag: m.tagName, src: (m.currentSrc || m.src || '').slice(0, 90), paused: m.paused })));
  out.netAfterPlay = net.filter((n) => n.t >= mark - 200).map((n) => `${n.method} ${n.status} [${n.type}] ${n.ct} ${n.url}`);
} catch (e) {
  out.fatal = e.message;
} finally {
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
