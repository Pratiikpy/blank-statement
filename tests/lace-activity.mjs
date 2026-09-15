// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Read the wallet's own Activity list.
//
// A designation that proves and then never appears in the balance has a fate
// recorded here — submitted, pending, or failed — and that is the difference
// between waiting longer and looking somewhere else entirely.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIND_DEEP = `(id) => {
  const hunt = (root, depth) => {
    if (!root || depth > 12) return null;
    const hit = root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = hunt(el.shadowRoot, depth + 1); if (r) return r; }
    }
    return null;
  };
  return hunt(document, 0);
}`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
await sleep(6000);
const ext = await ctx.newPage();
await ext.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(3000);
await ext.evaluate(`(() => { const f = ${FIND_DEEP}; const d = f('devMode'); if (d && d.getAttribute('aria-pressed') !== 'true') d.click(); })()`);
await sleep(3000);
await ext.evaluate(`(() => {
  const hunt = (root, depth) => {
    if (!root || depth > 12) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'EXTENSIONS-ITEM' && el.shadowRoot) {
        const t = el.shadowRoot.querySelector('#enableToggle');
        if (t && t.getAttribute('aria-pressed') !== 'true') t.click();
      }
      if (el.shadowRoot) hunt(el.shadowRoot, depth + 1);
    }
  };
  hunt(document, 0);
})()`);
await sleep(6000);
const sw = ctx.serviceWorkers()[0];
const extId = sw ? new URL(sw.url()).host : 'gafhhkghbfjjkeiendhlofajokpaflmk';
await ext.close().catch(() => {});

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(12000);

const pw = ui.locator('input[type="password"]:visible').first();
if (await pw.count().catch(() => 0)) {
  await pw.click().catch(() => {});
  await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}

const click = async (id) => {
  const box = await ui.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, id);
  if (!box) { console.log('  no', id); return false; }
  await ui.mouse.click(box.x, box.y);
  await sleep(5000);
  return true;
};

console.log('opening the Midnight account, then Activity');
// Activity lives on the account's own page, not the portfolio summary.
const card = await ui.evaluate(() => {
  const el = [...document.querySelectorAll('[data-testid]')]
    .find((e) => /Midnight #\d/.test(e.innerText ?? '') && (e.innerText ?? '').length < 80);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (card) { await ui.mouse.click(card.x, card.y); await sleep(5000); }
await click('activity-btn');
await sleep(5000);

// Whatever tab lists transactions.
const tab = await ui.evaluate(() => {
  const el = [...document.querySelectorAll('*')]
    .filter((e) => (e.innerText || '').trim() === 'Activity' && e.children.length <= 2)[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (tab) { console.log('  clicking the Activity tab'); await ui.mouse.click(tab.x, tab.y); await sleep(6000); }

const text = await ui.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n')).catch(() => '');
console.log('\nactivity screen:');
console.log(text.slice(0, 1200));
await ui.screenshot({ path: `${OUT}/lace-activity.png`, fullPage: true }).catch(() => {});
console.log('\nscreenshot -> lace-activity.png');

await ctx.close().catch(() => {});
process.exit(0);
