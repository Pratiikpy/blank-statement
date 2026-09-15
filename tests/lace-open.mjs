// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Open the fixture wallet, unlock it, and leave it on screen to be driven by
// hand.
//
// Some things are faster for a person than for a script: this wallet's UI is
// React Native Web with no stable route for its Activity list, and its Generate
// tDUST flow reaches "generating zero-knowledge proof" and then leaves the DUST
// cap at zero with no error anywhere a script can read — not the page console,
// not its network traffic, which happens in a service worker Playwright cannot
// see.
//
//   MINUTES=20 node tests/lace-open.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const PASSWORD = LACE_PASSWORD;
const MINUTES = Number(process.env.MINUTES ?? 20);
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
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
         '--window-size=1400,1000'],
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
await ui.setViewportSize({ width: 1360, height: 940 });
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
  await sleep(9000);
}

console.log('The wallet is open and unlocked. Password:', PASSWORD);
console.log(`Leaving it up for ${MINUTES} minutes.\n`);
console.log('  On the Midnight #0 card: Generate tDUST -> Send -> Send -> password -> Confirm');
console.log('  If it fails, the message it shows is the thing worth reporting.\n');

// Report the balance every half minute so the outcome is captured either way.
for (let i = 1; i <= MINUTES * 2; i++) {
  await sleep(30000);
  const s = await ui.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    return {
      night: (t.match(/tNIGHT ([\d,.]+)/) ?? [])[1] ?? null,
      dust: (t.match(/([\d,./ ]+)tDUST/) ?? [])[1]?.trim() ?? null,
    };
  }).catch(() => ({}));
  console.log(`  ${String(i * 30).padStart(4)}s  tNIGHT=${s.night ?? '?'}  tDUST=${s.dust ?? '?'}`);
  if (s.dust && !/^0 \/ 0/.test(s.dust)) {
    console.log('\nDUST is registered — the tank is filling.');
    break;
  }
}

await ctx.close().catch(() => {});
process.exit(0);
