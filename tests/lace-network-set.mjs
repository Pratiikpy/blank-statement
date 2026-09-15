// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Put Lace's Midnight network where we want it, and prove it stuck.
//
// Settings > Network offers Midnight three networks: Undeployed, Preview and
// Preprod. Undeployed is the local chain, which is the only one where a wallet
// here can actually pay a fee, so it is the one that makes a real signature
// possible. An earlier session concluded no Lace build offered the local
// network, having only read Cardano's own network list.
//
// The sheet needs its Confirm pressed, and the change is only real if it
// survives a reload, so this checks that rather than the radio's own tick.
//
//   NETWORK=undeployed node tests/lace-network-set.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24';
const PASSWORD = LACE_PASSWORD;
const NETWORK = (process.env.NETWORK ?? 'undeployed').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!['undeployed', 'preview', 'preprod'].includes(NETWORK)) {
  console.log('NETWORK must be undeployed, preview or preprod');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = null;
for (let i = 0; i < 15 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await sleep(1000); }
if (!sw) { console.log('the extension never started'); await ctx.close(); process.exit(2); }
const extId = new URL(sw.url()).host;

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
const open = async () => {
  await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(12000);
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
};
const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log('  no', what); return false; }
  await el.click({ timeout: 15000 }).then(() => console.log('  tap', what))
    .catch((e) => console.log(`  ${what}: ` + e.message.split('\n')[0].slice(0, 70)));
  await sleep(3500);
  return true;
};
// Which Midnight radio is ticked. The checkmark element only exists on the
// selected one, which is what makes this readable at all.
const selected = () => ui.evaluate(() => {
  const of = (n) => !!document.querySelector(`[data-testid="radio-button-midnight-${n}"] [data-testid$="checkmark"], [data-testid="radio-button-midnight-${n}-checkmark"]`);
  const ticked = ['undeployed', 'preview', 'preprod'].filter(of);
  return { ticked, midnightRow: (document.body.innerText.match(/Midnight has 3 options[^]*?Preprod/) ?? [])[0]?.slice(0, 80) ?? null };
}).catch(() => ({}));
// The wallet screen names the network it is on, which is the honest read: the
// settings radio is an intention, the address prefix is the outcome.
const addressPrefix = () => ui.evaluate(() => {
  const t = document.body.innerText;
  return (t.match(/mn_(?:shield-)?addr_[a-z]+/) ?? [])[0] ?? null;
}).catch(() => null);

await open();
console.log('before:', JSON.stringify(await selected()));

console.log(`\nsetting the Midnight network to ${NETWORK}`);
await tap('settings-tab-btn', 'Settings');
await tap('option-list-item-network', 'Network');
console.log('  on the sheet:', JSON.stringify(await selected()));
await ui.screenshot({ path: `${OUT}/network-set-before.png`, fullPage: true }).catch(() => {});

const picked = await tap(`radio-button-midnight-${NETWORK}`, `${NETWORK} radio`);
check('the network radio exists', picked);
console.log('  after picking:', JSON.stringify(await selected()));

const confirmed = await tap('network-selection-sheet-confirm-button', 'Confirm');
check('the sheet had a Confirm', confirmed);
// Switching networks makes the wallet resync, which takes a moment.
await sleep(15000);
await ui.screenshot({ path: `${OUT}/network-set-confirmed.png`, fullPage: true }).catch(() => {});

console.log('\nreopening to see whether it persisted');
await open();
const prefix = await addressPrefix();
console.log('  address on screen:', prefix);
await tap('settings-tab-btn', 'Settings');
await tap('option-list-item-network', 'Network');
const after = await selected();
console.log('  ticked now:', JSON.stringify(after.ticked));
await ui.screenshot({ path: `${OUT}/network-set-after.png`, fullPage: true }).catch(() => {});

check(`the Midnight radio is on ${NETWORK}`, (after.ticked ?? []).includes(NETWORK),
  JSON.stringify(after.ticked));
// The address prefix is the truth behind the radio.
if (prefix) {
  check(`the wallet address says ${NETWORK}`, prefix.includes(NETWORK), prefix);
} else {
  console.log('  note  no address was on screen to check the radio against');
}

await ctx.close().catch(() => {});
console.log(`\n${failures === 0 ? `Lace is on Midnight ${NETWORK}` : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
