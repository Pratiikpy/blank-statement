// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Point the main Lace extension's Midnight account at the local `undeployed`
// stack. It ships the same defaults the preview build did — node 9944, proof
// server 6300, indexer 8088 — but defaults to a hosted network, and a DApp
// asking to connect on `undeployed` gets an APIError until this is changed.
//
// The control is a sheet: network-selection-sheet, with
// network-selection-sheet-confirm-button to commit. Finding how to open it is
// the only fiddly part, so this searches rather than assuming a route.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-main';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-main-profile';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
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
// Right after the extension is re-enabled, Chrome sometimes blocks its pages
// for a moment (ERR_BLOCKED_BY_CLIENT). Retry rather than fail the run.
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' })
    .catch((e) => { console.log(`  open attempt ${i}:`, e.message.slice(0, 60)); return null; });
  if (r) break;
  await sleep(5000);
}
await sleep(12000);

const ids = () => ui.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
  .map((el) => el.getAttribute('data-testid')))]).catch(() => []);
const text = () => ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  console.log('  tapping', what);
  await el.click().catch((e) => console.log('    threw:', e.message.slice(0, 50)));
  await sleep(4000);
  return true;
};

console.log('wallet:', (await text()).slice(0, 120));
await ui.screenshot({ path: `${OUT}/main-lace-network-0.png` }).catch(() => {});

// Walk inwards looking for the sheet. Settings-ish controls first, then
// anything naming a network.
const PASSWORD = LACE_PASSWORD;

for (let round = 1; round <= 8; round++) {
  // An unlock modal sits over everything and swallows clicks, so every action
  // times out with no hint that a dialog is the reason. Clear it first.
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    console.log('  unlocking');
    await pw.click().catch(() => {});
    await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(8000);
  }

  const list = await ids();
  console.log(`\nround ${round}: ${JSON.stringify(list).slice(0, 380)}`);

  if (list.includes('network-selection-sheet')) {
    console.log('  the network sheet is open');
    const options = await ui.evaluate(() => [...document.querySelectorAll('[data-testid]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
      .map((el) => ({ t: el.getAttribute('data-testid'), l: (el.innerText || '').trim().slice(0, 24) }))
      .filter((o) => /undeployed|preview|preprod|qanet|mainnet|radio/i.test(o.t + ' ' + o.l))).catch(() => []);
    console.log('  options:', JSON.stringify(options).slice(0, 400));
    // Undeployed is in this build's code but not in its UI, which is why the
    // local chain is a dead end here. TARGET lets the caller take Testnet
    // instead, which is the network this build actually offers.
    const TARGET = process.env.LACE_NETWORK ?? 'undeployed';
    const wanted = options.find((o) => new RegExp(TARGET, 'i').test(o.t + ' ' + o.l));
    if (wanted) {
      await tap(wanted.t, TARGET);
      await tap('network-selection-sheet-confirm-button', 'confirm');
      console.log('\nnetwork now:', (await text()).slice(0, 140));
      await ui.screenshot({ path: `${OUT}/main-lace-network-set.png`, fullPage: true }).catch(() => {});
      break;
    }
    console.log('  no such option on this sheet; it offers only:',
      JSON.stringify(options.map((o) => o.l).filter(Boolean)));
    break;
  }

  const entry = list.find((t) => /network/i.test(t))
    ?? list.find((t) => /settings|gear|preferences/i.test(t))
    ?? list.find((t) => /menu|more/i.test(t));
  if (!entry) { console.log('  nothing to open'); break; }
  await tap(entry, entry);
  await ui.screenshot({ path: `${OUT}/main-lace-network-${round}.png` }).catch(() => {});
}

console.log('\nfinal:', (await text()).slice(0, 160));
await ctx.close().catch(() => {});
process.exit(0);
