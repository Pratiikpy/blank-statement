// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Ask the wallet for its Midnight address and balances through the DApp
// connector rather than by clicking around its UI.
//
// The main extension's portfolio is a carousel of account cards, so "the
// Receive button" is ambiguous and moves; the connector is stable and is the
// same path the app itself uses. It also reveals which network id this build
// answers to, which is not guessable — `undeployed` throws an APIError here.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
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
const swNow = ctx.serviceWorkers()[0];
const extId = swNow ? new URL(swNow.url()).host : 'gafhhkghbfjjkeiendhlofajokpaflmk';
await ext.close().catch(() => {});

// The connector answers "Wallet is locked" for everything until the extension
// itself is unlocked, and a page cannot do that. Open its UI and unlock first.
const ui = await ctx.newPage();
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' })
    .catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(12000);
{
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    console.log('unlocking the wallet');
    await pw.click().catch(() => {});
    await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
  // Give the wallet a moment to sync, then show what it actually holds: a
  // faucet payment can be on chain before the balance redraws.
  await sleep(15000);
  const seen = await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
  console.log('wallet screen:', seen.slice(0, 340));
  const night = seen.match(/([\d,.]+)\s*(tNIGHT|NIGHT)/);
  const dust = seen.match(/([\d,./ ]+)\s*tDUST/);
  console.log('  NIGHT on screen:', night ? night[0] : 'none');
  console.log('  DUST on screen :', dust ? dust[0].trim() : 'none');
  await ui.screenshot({ path: `${OUT}/main-lace-funded.png`, fullPage: true }).catch(() => {});
}

const page = await ctx.newPage();
for (let i = 0; i < 6; i++) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);
  if (await page.evaluate(() => !!window.midnight).catch(() => false)) break;
}
console.log('connector present:', await page.evaluate(() => !!window.midnight));

// Which network id does this build answer to? Try each without awaiting the
// whole thing, so the approval window can still be driven.
const NETWORKS = (process.env.LACE_NETWORK_IDS ?? 'testnet,preprod,preview,undeployed').split(',');
await page.evaluate((nets) => {
  window.__probe = {};
  const k = Object.keys(window.midnight)[0];
  for (const n of nets) {
    window.midnight[k].connect(n).then(
      async (s) => {
        const j = (v) => JSON.parse(JSON.stringify(v, (kk, vv) => (typeof vv === 'bigint' ? vv.toString() : vv)));
        const safe = async (fn) => { try { return j(await fn()); } catch (e) { return 'err: ' + String(e?.message ?? e).slice(0, 60); } };
        window.__probe[n] = {
          ok: true,
          config: await safe(() => s.getConfiguration()),
          unshielded: await safe(() => s.getUnshieldedAddress()),
          shielded: await safe(() => s.getShieldedAddresses()),
          dust: await safe(() => s.getDustBalance()),
          balances: await safe(() => s.getUnshieldedBalances()),
        };
      },
      (e) => { window.__probe[n] = { ok: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 90) }; },
    );
  }
}, NETWORKS);
console.log('asking for:', NETWORKS.join(', '));

// Drive whatever approval the wallet raises: pick the account, then authorise.
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  const done = await page.evaluate((n) => Object.keys(window.__probe ?? {}).length >= n, NETWORKS.length).catch(() => false);
  if (done) break;

  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || !p.url().startsWith('chrome-extension://')) continue;
    const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
    if (!ids.length) continue;
    const tap = async (id) => {
      console.log('  tapping', id);
      await p.locator(`[data-testid="${id}"]`).first().click().catch(() => {});
      await sleep(2500);
    };
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

const probe = await page.evaluate(() => window.__probe).catch(() => null);
console.log('\nresults:');
console.log(JSON.stringify(probe, null, 1).slice(0, 1400));
await page.screenshot({ path: `${OUT}/main-lace-session.png` }).catch(() => {});

// The faucet decodes a `shield-addr`, so the shielded address is the one that
// funds this wallet; the unshielded one is rejected. Write both, and make the
// shielded one the headline.
const shielded = Object.values(probe ?? {}).find((v) => v?.ok && v.shielded?.shieldedAddress);
if (shielded) {
  writeFileSync('/tmp/lace-main-shielded.txt', shielded.shielded.shieldedAddress + '\n');
  console.log('\nshielded address (this is what the faucet wants):');
  console.log(shielded.shielded.shieldedAddress);
  console.log('written to /tmp/lace-main-shielded.txt');
}

const good = Object.entries(probe ?? {}).find(([, v]) => v?.ok && v.unshielded?.unshieldedAddress);
if (good) {
  const [net, v] = good;
  const addr = v.unshielded.unshieldedAddress;
  writeFileSync('/tmp/lace-main-address.txt', addr + '\n');
  writeFileSync('/tmp/lace-main-network.txt', net + '\n');
  console.log(`\nnetwork id : ${net}`);
  console.log(`address    : ${addr}`);
  console.log('written to /tmp/lace-main-address.txt');
}

await ctx.close().catch(() => {});
process.exit(0);
