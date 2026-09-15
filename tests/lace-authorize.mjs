// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Connect the app to a Lace wallet that actually holds an account, and approve
// the request in the wallet the way a person would.
//
// The thing that wastes an afternoon: with no account, connect() rejects almost
// immediately, so awaiting it is fine. With an account it opens an approval
// window and *waits* — awaiting it inside page.evaluate() blocks the very
// script that has to click the approval, so the run sits there until something
// kills it, and the kill surfaces as "Target page, context or browser has been
// closed". That reads like a browser crash and is not one.
//
// So: start connect() without awaiting it, drive the approval window, then
// collect the result.
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
await ext.close().catch(() => {});

const page = await ctx.newPage();
for (let i = 0; i < 6; i++) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);
  if (await page.evaluate(() => !!window.midnight).catch(() => false)) break;
}
console.log('connector present:', await page.evaluate(() => !!window.midnight));

console.log('pill before:', JSON.stringify(await page.evaluate(
  () => document.querySelector('.walletpill')?.textContent.trim().slice(0, 80))));

// Press the app's own button rather than calling the connector directly: the
// point is that the product's path works, not that the API does.
await page.locator('.walletpill .linkbtn').first().click()
  .catch((e) => console.log('click threw:', e.message.slice(0, 70)));
console.log('pressed the app Connect wallet button');

// The app awaits connect() itself, so watch its own state rather than a promise.
await page.evaluate(() => { window.__laceDone = false; });

// Approve whatever window it raises.
let approved = false;
for (let i = 0; i < 24; i++) {
  await sleep(2500);
  const pill = await page.evaluate(
    () => document.querySelector('.walletpill')?.textContent.trim().slice(0, 120)).catch(() => '');
  if (pill && !/Connect wallet|Connecting/i.test(pill)) { console.log('the app settled:', JSON.stringify(pill)); break; }

  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || !p.url().startsWith('chrome-extension://')) continue;
    const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 240)).catch(() => '');
    if (!text) continue;
    console.log('\nwallet window:', JSON.stringify(text.slice(0, 200)));
    await p.screenshot({ path: `${OUT}/lace-authorize.png` }).catch(() => {});

    const pw = p.locator('input[type="password"]').first();
    if (await pw.count().catch(() => 0)) {
      console.log('  unlocking in the prompt');
      await pw.fill(PASSWORD).catch(() => {});
      await p.keyboard.press('Enter').catch(() => {});
      await sleep(6000);
    }
    // This wallet's UI is React Native Web: almost nothing is a <button>, so
    // report every visible testid and act on those instead of on tag names.
    const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
    console.log('  testids:', JSON.stringify(ids));

    const byId = async (re, what) => {
      const hit = ids.find((t) => re.test(t));
      if (!hit) return false;
      console.log('  tapping', what, '->', hit);
      await p.locator(`[data-testid="${hit}"]`).first().click().catch((e) =>
        console.log('    threw:', e.message.slice(0, 50)));
      await sleep(3000);
      return true;
    };
    // Account first, then the authorise control; the latter is inert until the
    // former is chosen.
    // Careful with the patterns: a loose /connect/ matches dapp-connector-logo,
    // which taps the picture and changes nothing while the loop spins.
    // The prompt in full: dropdown-button opens the account list, which reveals
    // dropdown-menu-item-N; dapp-connector-primary-button is Authorize and only
    // works once an account is picked. A loose /connect/ here would match
    // dapp-connector-logo and tap the picture forever.
    if (ids.some((t) => /^dropdown-menu-item-\d+$/.test(t))) {
      await byId(/^dropdown-menu-item-0$/, 'the Midnight account');
      await byId(/^dapp-connector-primary-button$/, 'Authorize');
      approved = true;
      continue;
    }
    if (ids.includes('dropdown-button')) { await byId(/^dropdown-button$/, 'the account list'); continue; }
    if (ids.includes('dapp-connector-primary-button')) {
      await byId(/^dapp-connector-primary-button$/, 'Authorize');
      approved = true;
      continue;
    }

    // Authorize stays disabled until an account is chosen, and the account is a
    // plain row rather than a button, so has-text on buttons never finds it.
    const authorize = p.locator('button:has-text("Authorize")').first();
    if (await authorize.count().catch(() => 0) && !(await authorize.isEnabled().catch(() => false))) {
      const row = p.getByText(/Midnight #\d/).first();
      if (await row.count().catch(() => 0)) {
        console.log('  choosing the Midnight account');
        await row.click().catch((e) => console.log('  row threw:', e.message.slice(0, 50)));
        await sleep(2500);
      }
    }
    // The main extension gates Authorize behind picking an account, so that
    // comes first; the next pass round the loop finds Authorize enabled.
    for (const label of ['Select Account', 'Midnight', 'Authorize', 'Allow', 'Connect', 'Approve', 'Accept', 'Confirm']) {
      const b = p.locator(`button:has-text("${label}")`).first();
      if (await b.count().catch(() => 0) && await b.isEnabled().catch(() => false)) {
        console.log('  pressing', label);
        await b.click().catch(() => {});
        approved = true;
        await sleep(5000);
        break;
      }
    }
  }
}
console.log('approved a prompt:', approved);

// Read the chain-side facts through a fresh session; the app holds its own.
const result = await page.evaluate(async () => {
  const k = Object.keys(window.midnight ?? {})[0];
  if (!k) return { err: 'no connector' };
  const s = await window.midnight[k].connect('undeployed');
  const j = (v) => JSON.parse(JSON.stringify(v, (kk, vv) => (typeof vv === 'bigint' ? vv.toString() : vv)));
  const safe = async (fn) => { try { return j(await fn()); } catch (e) { return 'err: ' + String(e?.message ?? e).slice(0, 70); } };
  return {
    dust: await safe(() => s.getDustBalance()),
    unshielded: await safe(() => s.getUnshieldedBalances()),
    shielded: await safe(() => s.getShieldedBalances()),
    unshieldedAddress: await safe(() => s.getUnshieldedAddress()),
    config: await safe(() => s.getConfiguration()),
  };
}).catch((e) => ({ err: String(e?.message ?? e).slice(0, 90) }));

console.log('\nsession:', JSON.stringify(result, null, 1).slice(0, 900));

console.log('\napp pill:', JSON.stringify(await page.evaluate(
  () => document.querySelector('.walletpill')?.textContent.trim().slice(0, 140)).catch(() => '')));
await page.screenshot({ path: `${OUT}/lace-connected.png` }).catch(() => {});

await ctx.close().catch(() => {});
process.exit(0);
