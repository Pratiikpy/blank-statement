// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What the app says about a wallet, in a real browser, in every state.
//
// The refusal copy is unit-tested against fabricated errors, which proves the
// mapping and nothing about what a person sees. This drives the real page with
// a real connector injected, and checks the words on screen for each state a
// wallet can be in: absent, present but not connected, declined, connected, and
// disconnected after it was connected.
//
// The last one is the one worth having. An earlier version of this app kept
// showing an address and a live dot after the extension had gone, which is the
// app lying about its own state, and that is the single thing this product
// cannot do.
//
//   node tests/wallet-states.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/wallet-states';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};

// A connector that behaves however the case needs, installed before the app
// loads so the page sees it exactly as it would see a real extension.
const injectConnector = (behaviour) => `
  window.__calls = [];
  const api = {
    name: 'testwallet',
    apiVersion: '4.0.1',
    isEnabled: async () => true,
    connect: async (networkId) => {
      window.__calls.push('connect:' + networkId);
      const mode = ${JSON.stringify(behaviour)};
      if (mode === 'declined') {
        const e = new Error('user said no');
        e.code = 'Rejected';
        throw e;
      }
      if (mode === 'disconnected') {
        const e = new Error('gone');
        e.code = 'Disconnected';
        throw e;
      }
      if (mode === 'broken') {
        const e = new Error('something went sideways');
        throw e;
      }
      return {
        getConfiguration: async () => ({
          networkId: 'undeployed',
          indexerUri: 'http://localhost:8088/api/v4/graphql',
          indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws',
          proverServerUri: 'http://localhost:6300',
        }),
        getShieldedAddresses: async () => ({
          shieldedAddress: 'mn_shield-addr_undeployed1test',
          shieldedCoinPublicKey: '00'.repeat(32),
          shieldedEncryptionPublicKey: '00'.repeat(32),
        }),
        getUnshieldedAddress: async () => ({ unshieldedAddress: 'mn_addr_undeployed1testwallet0000' }),
        getDustBalance: async () => ({ balance: 0n, cap: 0n }),
        getUnshieldedBalances: async () => ({}),
        balanceUnsealedTransaction: async () => ({ tx: '00' }),
        submitTransaction: async () => 'tx',
      };
    },
  };
  window.midnight = { testwallet: api };
`;

const browser = await chromium.launch({ headless: true });

const withWallet = async (behaviour, fn) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (behaviour !== 'none') await context.addInitScript(injectConnector(behaviour));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 140)); });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(2500);
  try { await fn(page, errors, context); } finally { await context.close().catch(() => {}); }
};
const header = (page) => page.locator('.top').innerText().catch(() => '');
const connectButton = (page) => page.locator('.linkbtn').first();

// ===========================================================================
console.log('1. no wallet at all');
// ===========================================================================
await withWallet('none', async (page, errors) => {
  const t = await header(page);
  check('W1a', 'it says there is no wallet', /No wallet/i.test(t), t.replace(/\s+/g, ' ').slice(0, 70));
  check('W1b', 'and explains it in a sentence',
    /No Midnight wallet in this browser/i.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('W1c', 'it shows no address', !/mn_addr|mn_shield/.test(t));
  check('W1d', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/1-none.png` }).catch(() => {});
});

// ===========================================================================
console.log('\n2. a wallet is there, not yet connected');
// ===========================================================================
await withWallet('ok', async (page, errors) => {
  const t = await header(page);
  check('W2a', 'the wallet is noticed', !/No Midnight wallet in this browser/i.test(t),
    t.replace(/\s+/g, ' ').slice(0, 90));
  check('W2b', 'and there is something to press', await connectButton(page).count() > 0);
  check('W2c', 'it does not claim to be connected', !/mn_addr_undeployed1testwallet/.test(t),
    t.replace(/\s+/g, ' ').slice(0, 90));
  check('W2d', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/2-available.png` }).catch(() => {});
});

// ===========================================================================
console.log('\n3. the person says no');
// ===========================================================================
await withWallet('declined', async (page, errors) => {
  const btn = connectButton(page);
  if (!(await btn.count())) { check('W3a', 'there is a connect control', false); return; }
  await btn.click();
  await sleep(2500);
  const t = await header(page);
  console.log('  ' + t.replace(/\s+/g, ' ').slice(0, 150));
  // The exact defect this app already had once: telling someone they declined
  // when they had not, or inventing a reason.
  check('W3a', 'it says the wallet did not approve it',
    /did not approve|declin/i.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('W3b', 'it does not claim a connection', !/mn_addr_undeployed1testwallet/.test(t));
  check('W3c', 'it does not blame something else',
    !/error|failed|wrong/i.test(t.replace(/No Midnight wallet[^.]*\./i, '')),
    t.replace(/\s+/g, ' ').slice(0, 110));
  check('W3d', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/3-declined.png` }).catch(() => {});
});

// ===========================================================================
console.log('\n4. the wallet goes away mid-question');
// ===========================================================================
await withWallet('disconnected', async (page, errors) => {
  const btn = connectButton(page);
  if (!(await btn.count())) { check('W4a', 'there is a connect control', false); return; }
  await btn.click();
  await sleep(2500);
  const t = await header(page);
  console.log('  ' + t.replace(/\s+/g, ' ').slice(0, 150));
  check('W4a', 'it says the wallet disconnected',
    /disconnect/i.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('W4b', 'it does not call that a refusal',
    !/did not approve/i.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('W4c', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/4-disconnected.png` }).catch(() => {});
});

// ===========================================================================
console.log('\n5. connected, then the extension is removed');
// ===========================================================================
await withWallet('ok', async (page, errors) => {
  const btn = connectButton(page);
  if (!(await btn.count())) { check('W5a', 'there is a connect control', false); return; }
  await btn.click();
  await sleep(3000);
  const connected = await header(page);
  check('W5a', 'it shows the address once connected',
    /mn_addr_undeployed1testwallet|testwallet/i.test(connected),
    connected.replace(/\s+/g, ' ').slice(0, 110));
  await page.screenshot({ path: `${OUT}/5-connected.png` }).catch(() => {});

  // Now take the wallet away, the way uninstalling an extension does.
  await page.evaluate(() => { delete window.midnight; });
  // The app polls every two seconds and also looks on focus.
  await sleep(7000);
  const after = await header(page);
  console.log('  after removing it: ' + after.replace(/\s+/g, ' ').slice(0, 130));
  check('W5b', 'the address stops being shown once the wallet is gone',
    !/mn_addr_undeployed1testwallet/.test(after), after.replace(/\s+/g, ' ').slice(0, 110));
  check('W5c', 'and it says there is no wallet again',
    /No wallet|No Midnight wallet/i.test(after), after.replace(/\s+/g, ' ').slice(0, 110));
  check('W5d', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/5-removed.png` }).catch(() => {});
});

// ===========================================================================
console.log('\n6. a wallet that fails for a reason of its own');
// ===========================================================================
await withWallet('broken', async (page, errors) => {
  const btn = connectButton(page);
  if (!(await btn.count())) { check('W6a', 'there is a connect control', false); return; }
  await btn.click();
  await sleep(2500);
  const t = await header(page);
  console.log('  ' + t.replace(/\s+/g, ' ').slice(0, 150));
  // An unknown failure must be passed through, not dressed up as a refusal.
  check('W6a', 'an unknown failure is not reported as a refusal',
    !/did not approve/i.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('W6b', 'and the wallet is not shown as connected',
    !/mn_addr_undeployed1testwallet/.test(t));
  check('W6c', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/6-broken.png` }).catch(() => {});
});

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
await browser.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
