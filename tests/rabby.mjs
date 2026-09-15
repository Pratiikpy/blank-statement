// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What happens when a real Rabby is installed and this app is opened.
//
// The claim being tested is one I had only asserted: that Rabby cannot serve a
// Midnight application. Asserting it is not evidence, so this loads the actual
// extension (downloaded from the Chrome Web Store, v0.94.4, MV3) into a real
// Chromium profile and reads what it injects and what the app then says.
//
// The expected result is not "it works". It is that the app detects a wallet it
// cannot use and says so in plain words, which is the correct behaviour and the
// only behaviour available.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const EXT = process.env.EXT ?? '/tmp/rabby/unpacked';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';

const profile = mkdtempSync(join(tmpdir(), 'rabby-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
  ],
});

// Give the service worker time to register and inject into pages.
await new Promise((r) => setTimeout(r, 6000));

const workers = ctx.serviceWorkers().map((w) => w.url());
const pages = ctx.pages().map((p) => p.url());
console.log('extension service workers:', workers.length);
for (const w of workers) console.log('  ' + w.slice(0, 90));
console.log('pages opened by the extension:', pages.length);

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tab', { timeout: 30000 });
await page.waitForTimeout(4000);

const injected = await page.evaluate(() => {
  const e = window.ethereum;
  return {
    hasEthereum: !!e,
    isRabby: !!e?.isRabby,
    isMetaMask: !!e?.isMetaMask,
    ethereumMethods: e ? ['request', 'on', 'removeListener'].filter((m) => typeof e[m] === 'function') : [],
    hasWindowMidnight: !!window.midnight,
    midnightKeys: window.midnight ? Object.keys(window.midnight) : null,
  };
});
console.log('\nwhat Rabby injected:');
console.log('  window.ethereum        ', injected.hasEthereum);
console.log('  ethereum.isRabby       ', injected.isRabby);
console.log('  ethereum methods       ', injected.ethereumMethods.join(', '));
console.log('  window.midnight        ', injected.hasWindowMidnight, injected.midnightKeys ?? '');

// Ask Rabby directly for its chain, to show it really is an EVM provider.
const evm = await page.evaluate(async () => {
  try {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    return { ok: true, chainId };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
});
console.log('  eth_chainId            ', JSON.stringify(evm));

const pill = await page.evaluate(() => {
  const p = document.querySelector('.walletpill');
  return {
    text: p?.textContent.trim().slice(0, 130),
    dot: p?.querySelector('.dot')?.className,
    hasConnectButton: !!p?.querySelector('.linkbtn'),
  };
});
console.log('\nwhat the app says with a real Rabby installed:');
console.log('  pill      ', JSON.stringify(pill.text));
console.log('  dot       ', pill.dot);
console.log('  offers connect?', pill.hasConnectButton);

await page.screenshot({ path: `${OUT}/rabby-installed-app-response.png` });
console.log(`\nscreenshot: ${OUT}/rabby-installed-app-response.png`);

// And prove the app still works fully with Rabby present — it must not break.
const works = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
  recordTiles: [...document.querySelectorAll('.statrow .stat')].map((s) => s.textContent.replace(/\s+/g, ' ')),
}));
console.log('\nthe product with Rabby installed:');
console.log('  tabs   ', JSON.stringify(works.tabs));
console.log('  record ', JSON.stringify(works.recordTiles));

await ctx.close();
process.exit(0);
