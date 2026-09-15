// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Give the fixture wallet something to pay fees with, and prove it arrived.
//
// On Midnight, fees are paid in DUST, which is generated from registered NIGHT
// holdings. A wallet with no DUST cannot send anything at all, so this is the
// gate between "Lace is connected" and "Lace can actually sign a transaction".
//
// Lace's undeployed build carries its own "Generate tDUST" action, which is the
// supported way to do this on a local chain. Balances are read back from the
// DApp connector afterwards, not from the wallet's own screen, because the
// screen is what we are trying to check.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-profile';
const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
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
const extId = sw ? new URL(sw.url()).host : 'hgeekaiplokcnmakghbdfbgnlfheichg';

const ui = await ctx.newPage();
await ui.goto(`chrome-extension://${extId}/tab.html`, { waitUntil: 'domcontentloaded' });
await sleep(10000);
const pw = ui.locator('input[type="password"]').first();
if (await pw.count().catch(() => 0)) {
  await pw.fill(PASSWORD).catch(() => {});
  await ui.keyboard.press('Enter').catch(() => {});
  await sleep(8000);
}
console.log('wallet:', await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 110)).catch(() => ''));

const balances = async (label) => {
  const page = ctx.pages().find((p) => !p.isClosed() && p.url().startsWith(APP)) ?? await ctx.newPage();
  if (!page.url().startsWith(APP)) {
    for (let i = 0; i < 6; i++) {
      await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(5000);
      if (await page.evaluate(() => !!window.midnight).catch(() => false)) break;
    }
  }
  const b = await page.evaluate(async () => {
    const k = Object.keys(window.midnight ?? {})[0];
    if (!k) return { err: 'no connector' };
    const s = await window.midnight[k].connect('undeployed');
    const j = (v) => JSON.parse(JSON.stringify(v, (kk, vv) => (typeof vv === 'bigint' ? vv.toString() : vv)));
    const safe = async (fn) => { try { return j(await fn()); } catch (e) { return 'err: ' + String(e?.message ?? e).slice(0, 60); } };
    return {
      dust: await safe(() => s.getDustBalance()),
      unshielded: await safe(() => s.getUnshieldedBalances()),
      shielded: await safe(() => s.getShieldedBalances()),
      address: await safe(() => s.getUnshieldedAddress()),
    };
  }).catch((e) => ({ err: String(e?.message ?? e).slice(0, 80) }));
  console.log(`\n[${label}]`);
  console.log('  ' + JSON.stringify(b).slice(0, 400));
  return b;
};

const before = await balances('before');

// Lace's own local-chain faucet.
console.log('\nclicking "Generate tDUST"');
const gen = ui.locator('button:has-text("Generate tDUST"), [data-testid*="dust"]').first();
if (!(await gen.count().catch(() => 0))) {
  console.log('  no such control on this screen');
} else {
  await gen.click().catch((e) => console.log('  click threw:', e.message.slice(0, 70)));
  await sleep(6000);
  console.log('  screen now:', await ui.evaluate(
    () => document.body.innerText.replace(/\s+/g, ' ').slice(0, 260)).catch(() => ''));
  await ui.screenshot({ path: `${OUT}/lace-generate-dust.png`, fullPage: true }).catch(() => {});

  // Whatever dialog it opened, drive it.
  for (const label of ['Confirm', 'Generate', 'Continue', 'Proceed', 'Send']) {
    const b = ui.locator(`button:has-text("${label}")`).first();
    if (await b.count().catch(() => 0)) {
      console.log('  pressing', label);
      await b.click().catch(() => {});
      await sleep(8000);
    }
  }
  const pw2 = ui.locator('input[type="password"]').first();
  if (await pw2.count().catch(() => 0)) {
    console.log('  password requested, entering it');
    await pw2.fill(PASSWORD).catch(() => {});
    await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
  console.log('  after:', await ui.evaluate(
    () => document.body.innerText.replace(/\s+/g, ' ').slice(0, 260)).catch(() => ''));
  await ui.screenshot({ path: `${OUT}/lace-generate-dust-after.png`, fullPage: true }).catch(() => {});
}

// DUST accrues over time from registered NIGHT, so give it a while.
for (const wait of [15000, 25000]) {
  await sleep(wait);
  const b = await balances(`after waiting ${Math.round(wait / 1000)}s more`);
  const d = b?.dust?.balance;
  if (d && d !== '0' && d !== '0n') { console.log('\nDUST arrived:', d); break; }
}

console.log('\nbefore dust:', JSON.stringify(before?.dust));
await ctx.close().catch(() => {});
process.exit(0);
