// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Read the Midnight account's receiving address out of the main Lace
// extension, so it can be funded.
//
// The address is taken from the DOM rather than from a screenshot: one wrong
// character sends funds somewhere unrecoverable, and bech32 wraps across lines
// on screen.
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
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' })
    .catch(() => null);
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

const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  console.log('  tapping', what);
  await el.click().catch((e) => console.log('    threw:', e.message.slice(0, 50)));
  await sleep(5000);
  return true;
};
const grab = () => ui.evaluate(() => {
  // bech32 wraps on screen, so strip whitespace before matching.
  const joined = document.body.innerText.replace(/\s+/g, '');
  const all = joined.match(/mn_[a-z-]{2,12}_[a-z]+1[0-9a-z]{30,}/g) ?? [];
  return [...new Set(all)];
}).catch(() => []);

console.log('wallet:', (await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '')));

// The portfolio stacks both accounts on one page, so there are two Receive
// buttons and .first() is Cardano's. Pick the one inside the card that names
// Midnight.
const which = await ui.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-testid="receive-button"]')];
  return btns.findIndex((b) => {
    let n = b;
    for (let up = 0; up < 8 && n; up++, n = n.parentElement) {
      if (/Midnight/i.test(n.innerText ?? '')) return true;
    }
    return false;
  });
}).catch(() => -1);
console.log('  Receive buttons on the page, Midnight is index', which);
if (which >= 0) {
  await ui.locator('[data-testid="receive-button"]').nth(which).click()
    .catch((e) => console.log('    threw:', e.message.slice(0, 50)));
  await sleep(6000);
} else {
  await tap('receive-button', 'Receive');
}
await ui.screenshot({ path: `${OUT}/main-lace-receive.png`, fullPage: true }).catch(() => {});

let found = await grab();
if (!found.length) {
  // Some builds put Receive behind the account card instead.
  await tap('account-card-accounts-button', 'accounts');
  await sleep(3000);
  await tap('receive-button', 'Receive');
  found = await grab();
}

console.log('\naddresses on screen:');
for (const a of found) console.log('  ' + a);

const midnight = found.filter((a) => !/addr_test1|addr1/.test(a));
if (midnight.length) {
  writeFileSync('/tmp/lace-main-address.txt', midnight.join('\n') + '\n');
  console.log('\nwritten to /tmp/lace-main-address.txt');
} else {
  console.log('\nno Midnight address on this screen');
  console.log('screen:', (await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)).catch(() => '')));
}

await ctx.close().catch(() => {});
process.exit(0);
