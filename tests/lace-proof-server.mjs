// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Point Lace's Midnight proof server at the local one.
//
// The Generate tDUST panel carries a warning that sending on Midnight requires
// a local proof server, and with the setting on Remote its Send button does
// nothing at all — no error, no dialog, the panel just sits there. This flips
// it to Local, which is the proof server this repo already runs on 6300.
//
//   PROOF=local node tests/lace-proof-server.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const PROOF = process.env.PROOF ?? 'local';
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
  console.log('unlocking');
  await pw.click().catch(() => {});
  await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}

// Real mouse clicks throughout: this UI ignores synthetic element.click().
const clickId = async (id, what = id) => {
  const box = await ui.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
  if (!box) { console.log(`  no ${what}`); return false; }
  console.log('  click', what);
  await ui.mouse.click(box.x, box.y);
  await sleep(4000);
  return true;
};
const checks = () => ui.evaluate(() => ({
  local: !!document.querySelector('[data-testid="proof-server-local-radio-checkmark"]'),
  remote: !!document.querySelector('[data-testid="proof-server-remote-radio-checkmark"]'),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
})).catch(() => ({}));

await clickId('settings-tab-btn', 'Settings');
await clickId('option-list-item-midnight', 'Midnight');
console.log('\nbefore:', JSON.stringify(await checks()));
await ui.screenshot({ path: `${OUT}/proof-server-before.png`, fullPage: true }).catch(() => {});

await clickId(`proof-server-${PROOF}-radio`, `${PROOF} proof server`);
console.log('after selecting:', JSON.stringify(await checks()));

// Some builds want an explicit save.
for (const id of ['network-selection-sheet-confirm-button', 'confirm-button', 'save-button', 'next-btn']) {
  if (await clickId(id, id)) break;
}
console.log('\nfinal:', JSON.stringify(await checks()));
await ui.screenshot({ path: `${OUT}/proof-server-after.png`, fullPage: true }).catch(() => {});

await ctx.close().catch(() => {});
process.exit(0);
