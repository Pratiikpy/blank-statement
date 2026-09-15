// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Does the browser-side wallet path build against a real wallet?
//
// This checks the wiring only: connector found, providers constructed from the
// wallet's own configuration, and the wallet's funds reported. It stops short
// of writing, because a wallet with no DUST cannot pay a fee and the write
// would hang rather than fail — which is exactly the trap this reports on.
//
//   LACE_NETWORK_IDS=preview node tests/wallet-path.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const NETWORK = process.env.NETWORK ?? 'preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

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

// The connector answers "Wallet is locked" for everything until the extension
// is unlocked, and a page cannot do that itself.
const ui = await ctx.newPage();
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(11000);
{
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
}

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
// Name the URL behind any 404: a missing zk artifact reads exactly like a
// missing favicon in the console, and they matter very differently.
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 110)); });

for (let i = 0; i < 6; i++) {
  await page.goto(`${APP}/wallet-write.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  if (await page.evaluate(() => typeof window.checkWallet === 'function').catch(() => false)) break;
}

console.log('\n1. the browser side');
check('the module loaded in the browser',
  await page.evaluate(() => typeof window.checkWallet === 'function').catch(() => false));
check('the connector is present', await page.evaluate(() => !!window.midnight).catch(() => false));

// Fire without awaiting: the wallet may raise an approval window and awaiting
// here would block the code that has to click it.
await page.evaluate((n) => { window.checkWallet({ networkId: n }); }, NETWORK)
  .catch((e) => console.log('  kick threw:', e.message.slice(0, 70)));
console.log(`\n2. connecting on ${NETWORK}`);

for (let i = 0; i < 30; i++) {
  await sleep(3000);
  if (await page.evaluate(() => !!window.__result).catch(() => false)) break;
  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || p === ui || !p.url().startsWith('chrome-extension://')) continue;
    const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
    if (!ids.length) continue;
    const tap = async (id) => {
      const box = await p.evaluate((t) => {
        const el = document.querySelector(`[data-testid="${t}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 1 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      }, id).catch(() => null);
      if (!box) return false;
      console.log('  wallet prompt: tapping', id);
      await p.mouse.click(box.x, box.y);
      await sleep(3000);
      return true;
    };
    // Authorize is inert until an account is picked.
    if (ids.some((t) => /^dropdown-menu-item-\d+$/.test(t))) {
      await tap('dropdown-menu-item-0');
      await tap('dapp-connector-primary-button');
    } else if (ids.includes('dropdown-button')) {
      await tap('dropdown-button');
    } else if (ids.includes('dapp-connector-primary-button')) {
      await tap('dapp-connector-primary-button');
    }
  }
}

const result = await page.evaluate(() => window.__result).catch(() => null);
const log = await page.evaluate(() => window.__log).catch(() => '');
console.log('\npage log:');
for (const l of String(log).split('\n').filter(Boolean)) console.log('   ' + l);
await page.screenshot({ path: `${OUT}/wallet-path.png` }).catch(() => {});

console.log('\n3. what came back');
check('the wallet connected', result?.ok === true, result?.message ?? '');
if (result?.ok) {
  check('providers were built from the wallet config',
    (result.providers ?? []).length === 5, JSON.stringify(result.providers));
  check('it is on the expected network', result.networkId === NETWORK, result.networkId);
  check('the wallet holds NIGHT', BigInt(result.night ?? '0') > 0n, result.night);
  // Reported, not asserted: this is the known blocker, and a red line here is
  // the honest state rather than a broken test.
  // Reported, not asserted, and read from the balance rather than the cap: the
  // local chain's own funded wallet signs everything with a cap of 0.
  console.log(`  ${result.canPayFees ? 'ok  ' : 'note'}  can pay fees               dust=${result.dust}`);
}
if (bad.length) {
  console.log('\nrequests that did not succeed:');
  for (const b of [...new Set(bad)].slice(0, 8)) console.log('   ' + b);
}
// A favicon 404 is noise; anything under the contract artifacts is not.
const realFailures = [...new Set(bad)].filter((b) => !/favicon/i.test(b));
check('nothing important 404d', realFailures.length === 0, realFailures.slice(0, 2).join(' | '));
check('no page errors', errors.filter((e) => !/favicon/i.test(e) && !/404/.test(e)).length === 0,
  errors.slice(0, 2).join(' | '));

console.log(`\n${failures === 0 ? 'the wallet path builds' : failures + ' check(s) failed'}`);
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
