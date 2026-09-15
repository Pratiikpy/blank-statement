// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Watch the wallet until the faucet payment lands, in one browser session.
//
// Relaunching the browser per check costs a minute each time and makes the
// wallet resync from cold; holding it open lets it stream from the indexer the
// way it normally would.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const MINUTES = Number(process.env.WATCH_MINUTES ?? 8);
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
await ui.setViewportSize({ width: 1280, height: 1000 });
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(12000);

const pw = ui.locator('input[type="password"]:visible').first();
if (await pw.count().catch(() => 0)) {
  console.log('unlocking');
  await pw.click().catch(() => {});
  await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}

const rounds = Math.max(1, Math.round((MINUTES * 60) / 30));
let landed = false;
for (let i = 1; i <= rounds; i++) {
  const seen = await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
  const tokens = seen.match(/(\d[\d,.]*)\s*Tokens/);
  const dust = seen.match(/([\d,./ ]+)tDUST/);
  const empty = /don't have any assets/i.test(seen);
  console.log(`  ${String(i * 30).padStart(4)}s  tokens=${tokens ? tokens[1] : '?'}  dust=${dust ? dust[1].trim() : '?'}  ${empty ? 'no assets' : 'HAS ASSETS'}`);

  if (!empty || (tokens && tokens[1] !== '0')) {
    landed = true;
    console.log('\nsomething arrived:');
    console.log('  ' + seen.slice(0, 300));
    await ui.screenshot({ path: `${OUT}/main-lace-funded.png`, fullPage: true }).catch(() => {});
    break;
  }
  await sleep(30000);
}

if (!landed) {
  console.log(`\nnothing after ${MINUTES} minutes`);
  await ui.screenshot({ path: `${OUT}/main-lace-still-empty.png`, fullPage: true }).catch(() => {});
}
await ctx.close().catch(() => {});
process.exit(landed ? 0 : 3);
