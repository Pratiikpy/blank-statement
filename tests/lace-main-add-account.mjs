// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Add a second Midnight account and print its unshielded address.
//
// The preview faucet is rate limited and refused a second request. If that
// limit is per address rather than per IP, a fresh account has its own
// allowance, and this is the cheapest way to find out. The faucet takes the
// unshielded `mn_addr_` form only: it rejects shielded and DUST addresses.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
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

const ids = () => ui.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
  .map((el) => el.getAttribute('data-testid')))]).catch(() => []);
const txt = () => ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)).catch(() => '');
const tap = async (id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  console.log('  tap', id);
  await el.click().catch((e) => console.log('    threw:', e.message.slice(0, 45)));
  await sleep(4500);
  return true;
};

console.log('wallet:', await txt());
await tap('accounts-button');
console.log('\nafter Accounts:', await txt());
console.log('ids:', JSON.stringify(await ids()).slice(0, 500));
await ui.screenshot({ path: `${OUT}/main-lace-accounts.png`, fullPage: true }).catch(() => {});

// Whatever this build calls "add an account".
const list = await ids();
const add = list.find((t) => /add.*account|account.*add|create.*account|new-account/i.test(t));
if (add) {
  await tap(add);
  console.log('\nafter add:', await txt());
  console.log('ids:', JSON.stringify(await ids()).slice(0, 500));
  await ui.screenshot({ path: `${OUT}/main-lace-add-account.png`, fullPage: true }).catch(() => {});

  // A Midnight account, not a Cardano one.
  const l2 = await ids();
  const midnight = l2.find((t) => /midnight/i.test(t));
  if (midnight) await tap(midnight);
  for (const t of ['next-btn', 'confirm', 'create']) {
    const hit = (await ids()).find((x) => new RegExp(t, 'i').test(x));
    if (hit) await tap(hit);
  }
  console.log('\nafter creating:', await txt());
} else {
  console.log('\nno add-account control found; ids above are what this screen offers');
}
await ui.screenshot({ path: `${OUT}/main-lace-accounts-final.png`, fullPage: true }).catch(() => {});

const addrs = await ui.evaluate(() => [...new Set((document.body.innerText.replace(/\s+/g, '')
  .match(/mn_addr_[a-z]+1[0-9a-z]{25,}/g) ?? []))]).catch(() => []);
console.log('\nunshielded addresses visible:', JSON.stringify(addrs));
if (addrs.length) writeFileSync('/tmp/lace-accounts.txt', addrs.join('\n') + '\n');

await ctx.close().catch(() => {});
process.exit(0);
