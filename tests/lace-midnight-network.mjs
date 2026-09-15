// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Set the Midnight network in the main Lace extension.
//
// Settings has two separate entries: `option-list-item-network`, which is
// Cardano's Mainnet/Testnet switch, and `option-list-item-midnight`, which is
// Midnight's own. Opening the first one and reading "Mainnet / Testnet" is what
// led to the wrong conclusion that this build cannot reach preprod.
//
//   LACE_MIDNIGHT_NETWORK=preprod node tests/lace-midnight-network.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const TARGET = process.env.LACE_MIDNIGHT_NETWORK ?? '';
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

const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`  no ${what}`); return false; }
  console.log('  tap', what);
  await el.click().catch((e) => console.log('    threw:', e.message.slice(0, 45)));
  await sleep(4500);
  return true;
};
const look = async (label) => {
  const s = await ui.evaluate(() => ({
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    ids: [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
      .map((e) => e.getAttribute('data-testid')))],
  })).catch(() => ({ ids: [] }));
  console.log(`\n[${label}] ${JSON.stringify((s.text ?? '').slice(0, 220))}`);
  console.log('  ids:', JSON.stringify(s.ids ?? []).slice(0, 620));
  await ui.screenshot({ path: `${OUT}/midnight-net-${label}.png`, fullPage: true }).catch(() => {});
  return s;
};

await tap('settings-tab-btn', 'Settings');
await look('settings');
await tap('option-list-item-midnight', 'Midnight settings');
await look('midnight');

// This screen has its own Network entry, separate from Cardano's. That nested
// one is where the Midnight networks actually live.
await tap('option-list-item-network', 'Midnight > Network');
const page = await look('midnight-network');

// Whatever network options this screen offers.
const opts = await ui.evaluate(() => [...document.querySelectorAll('[data-testid]')]
  .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
  .map((e) => ({ t: e.getAttribute('data-testid'), l: (e.innerText || '').trim().slice(0, 30) }))
  .filter((o) => /undeployed|preview|preprod|qanet|mainnet|testnet|radio|network|node|indexer|proof/i
    .test(o.t + ' ' + o.l))).catch(() => []);
console.log('\nnetwork-ish controls:');
console.log(JSON.stringify(opts, null, 1).slice(0, 1100));

if (TARGET) {
  const wanted = opts.find((o) => new RegExp(TARGET, 'i').test(o.t + ' ' + o.l));
  if (!wanted) {
    console.log(`\nno "${TARGET}" option here`);
  } else {
    await tap(wanted.t, TARGET);
    for (const id of ['network-selection-sheet-confirm-button', 'confirm-button', 'next-btn']) {
      if (await tap(id, id)) break;
    }
    console.log('\nafter switching:', (await look('after')).text?.slice(0, 200));
  }
}

await ctx.close().catch(() => {});
process.exit(0);
