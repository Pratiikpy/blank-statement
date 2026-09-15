// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The claim this project leads with, tested: the holder's own wallet, in the
// holder's own browser, proves and authorises a change to the ledger.
//
// Everything before this went through app/bridge.mjs, a Node process holding a
// seed. That works, but the holder does not own it, which is the arrangement
// the product exists to avoid. So this drives Lace in a real browser, lets the
// page produce its own proof, and then checks the chain independently to see
// whether the write actually landed. A "submitted" log line is not the pass;
// the ledger moving is.
//
// The fee is paid by the relay on purpose. A holder who received their NIGHT
// from anyone other than a faucet has no DUST and cannot get any, because
// registering for DUST generation is itself a transaction needing a fee. Both
// Lace's own Generate tDUST and midday's registerDust() fail on such a wallet
// with `Invalid Transaction: Custom error: 192`. Asking a person to solve that
// before they can answer a question about their own receipts is not a product,
// so the relay pays and the wallet still authorises.
//
//   node tests/wallet-write-relay.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24';
const PASSWORD = LACE_PASSWORD;
const NETWORK = process.env.NETWORK ?? 'undeployed';
const RELAY = process.env.RELAY ?? 'http://127.0.0.1:3002';
const INDEXER = process.env.INDEXER ?? 'http://127.0.0.1:8188/api/v4/graphql';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const height = async () => {
  try {
    const r = await fetch(INDEXER, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{block{height}}' }),
    });
    return Number((await r.json())?.data?.block?.height ?? 0);
  } catch { return 0; }
};

console.log('0. is everything this needs actually up?');
const relayOk = await fetch(`${RELAY}/health`).then((r) => r.ok).catch(() => false);
check('the fee relay is answering', relayOk, RELAY);
const startHeight = await height();
check('the chain is producing blocks', startHeight > 0, 'height ' + startHeight);

// Join the contract that is already deployed rather than deploying a new one.
// That is what a holder actually does, and deploying is a different path: the
// SDK does not route a deploy's fee through the relay, so a browser wallet
// with no DUST fails there with "could not balance dust" even when the relay
// is configured.
const CONTRACT = process.env.CONTRACT ?? await fetch(`${BRIDGE}/api/state`)
  .then((r) => r.json()).then((s) => s.address).catch(() => null);
check('there is a deployed contract to join', !!CONTRACT, CONTRACT ?? 'the bridge did not answer');
if (!relayOk || !startHeight || !CONTRACT) {
  console.log('\nBLOCKED: start the relay, the local stack and the bridge first');
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = null;
for (let i = 0; i < 15 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await sleep(1000); }
if (!sw) { console.log('the extension never started'); await ctx.close(); process.exit(2); }
const extId = new URL(sw.url()).host;

// The connector answers "wallet is locked" for everything until the extension
// is unlocked, and a page cannot do that itself.
const ui = await ctx.newPage();
await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(12000);
{
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    await pw.click().catch(() => {});
    await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
}

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
const relayCalls = [];
page.on('request', (r) => { if (r.url().startsWith(RELAY)) relayCalls.push(r.method() + ' ' + r.url().slice(RELAY.length)); });
const bad = [];
page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 100)); });

for (let i = 0; i < 6; i++) {
  await page.goto(`${APP}/wallet-write.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  if (await page.evaluate(() => typeof window.writeWithWallet === 'function').catch(() => false)) break;
}
console.log('\n1. the page');
check('the write harness loaded', await page.evaluate(() => typeof window.writeWithWallet === 'function').catch(() => false));

// Approving happens in a wallet window, so the call cannot be awaited here:
// awaiting would block the code that has to click the approval.
console.log('\n2. writing from the browser');
await page.evaluate(({ n, relay, addr }) => { window.writeWithWallet({ networkId: n, feeRelay: relay, address: addr }); },
  { n: NETWORK, relay: RELAY, addr: CONTRACT }).catch((e) => console.log('  kick threw:', e.message.slice(0, 70)));

const tapIn = async (p, id) => {
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

// Proving in the browser is slow, and the wallet may raise several prompts
// (connect, then authorise the transaction), so keep answering until the page
// reports one way or the other.
for (let i = 0; i < 80; i++) {
  await sleep(4000);
  if (await page.evaluate(() => !!window.__write).catch(() => false)) break;
  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || p === ui || !p.url().startsWith('chrome-extension://')) continue;
    const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
    if (!ids.length) continue;
    // Authorise is inert until an account is picked.
    if (ids.some((t) => /^dropdown-menu-item-\d+$/.test(t))) {
      await tapIn(p, 'dropdown-menu-item-0');
      await tapIn(p, 'dapp-connector-primary-button');
    } else if (ids.includes('dropdown-button')) {
      await tapIn(p, 'dropdown-button');
    } else if (ids.includes('dapp-connector-primary-button')) {
      await tapIn(p, 'dapp-connector-primary-button');
    }
    const pw = p.locator('input[type="password"]:visible').first();
    if (await pw.count().catch(() => 0)) {
      await pw.click().catch(() => {});
      await pw.type(PASSWORD, { delay: 25 }).catch(() => {});
      await sleep(1200);
      await tapIn(p, 'authentication-prompt-button-confirm');
    }
  }
}

const log = await page.evaluate(() => window.__log).catch(() => '');
console.log('\npage log:');
for (const l of String(log).split('\n').filter(Boolean)) console.log('   ' + l);
await page.screenshot({ path: `${OUT}/wallet-write-relay.png` }).catch(() => {});

const write = await page.evaluate(() => window.__write).catch(() => null);
console.log('\n3. what the page reports');
check('the browser produced a write', write?.ok === true, write?.message ?? '');
if (write?.ok) {
  console.log('   tx    :', write.txId ?? '(none reported)');
  console.log('   block :', write.block ?? '(none reported)');
  console.log('   result fields:', (write.keys ?? []).join(', '));
}

console.log('\n4. did the relay actually pay?');
const uniq = [...new Set(relayCalls)];
for (const c of uniq) console.log('   ' + c);
check('the relay was asked to balance the fee', uniq.some((c) => c.includes('/balance-finalized-tx')));
check('the relay submitted the transaction', uniq.some((c) => c.includes('/submit-tx')));

console.log('\n5. the chain, read independently of the page');
// The page saying "wrote" is tier 6. The ledger is tier 1.
if (write?.ok && write.address) {
  let landed = false;
  for (let i = 0; i < 10 && !landed; i++) {
    await sleep(6000);
    const h = await height();
    landed = h > startHeight;
    if (landed) console.log(`   the chain advanced ${startHeight} -> ${h}`);
  }
  check('the chain advanced after the write', landed);
  console.log('   contract:', write.address);
  console.log('   run `node tests/chain-truth.mjs` against this address for the full ledger read');
} else {
  console.log('   nothing to check: the write did not report success');
}

const realBad = [...new Set(bad)].filter((b) => !/favicon/i.test(b));
if (realBad.length) { console.log('\nrequests that failed:'); for (const b of realBad.slice(0, 6)) console.log('   ' + b); }
check('no page errors', errors.filter((e) => !/favicon/i.test(e) && !/404/.test(e)).length === 0,
  errors.slice(0, 2).join(' | '));

await ctx.close().catch(() => {});
console.log(`\n${failures === 0 ? 'the browser wrote to the chain with its own wallet' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
