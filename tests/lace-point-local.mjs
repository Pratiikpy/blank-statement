// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Point Lace's Midnight settings at the local chain, and save them.
//
// Lace's Midnight Settings sheet holds four things, not one: the proof server
// radio, an editable Node address, an editable Indexer address, and a "Save
// configuration" button. Two earlier scripts changed the radio and never
// pressed Save, so the change was discarded on the next screen and the wallet
// went on proving against the remote server. That is why the local proof
// server recorded no request while the panel claimed to be set to Local.
//
// Pointing the node and indexer at the local chain matters more than the proof
// server: the local chain is where wallets have DUST, so it is where a
// signature can actually happen.
//
//   NODE=ws://127.0.0.1:9944 INDEXER=http://127.0.0.1:8188/api/v4/graphql \
//     node tests/lace-point-local.mjs
//
// Pass NODE=preview to put it back on the public network.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24';
const PASSWORD = LACE_PASSWORD;
const PROOF = process.env.PROOF ?? 'local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESET = {
  preview: {
    node: 'https://rpc.preview.midnight.network',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  },
  local: {
    // Lace talks to the node over http, the same way the bridge's providers do.
    node: process.env.NODE_URL ?? 'http://127.0.0.1:9944',
    indexer: process.env.INDEXER_URL ?? 'http://127.0.0.1:8188/api/v4/graphql',
  },
};
const target = PRESET[process.env.TARGET ?? 'local'] ?? PRESET.local;

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
const openSheet = async () => {
  await tap('settings-tab-btn', 'Settings');
  await tap('option-list-item-midnight', 'Midnight');
};
// The two addresses are the only free-text inputs on this sheet, in the order
// the sheet shows them: node first, indexer second.
const readSheet = () => ui.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ');
  const inputs = [...document.querySelectorAll('input, textarea')]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 40 && i.type !== 'password'; })
    .map((i) => i.value ?? '');
  return {
    local: !!document.querySelector('[data-testid="proof-server-local-radio-checkmark"]'),
    remote: !!document.querySelector('[data-testid="proof-server-remote-radio-checkmark"]'),
    inputs,
    node: (text.match(/Node address (\S+)/) ?? [])[1] ?? null,
    indexer: (text.match(/Indexer address (\S+)/) ?? [])[1] ?? null,
  };
}).catch(() => ({}));

await open();
console.log('opening Midnight Settings');
await openSheet();
const before = await readSheet();
console.log('before:', JSON.stringify(before));
await ui.screenshot({ path: `${OUT}/point-local-before.png`, fullPage: true }).catch(() => {});

console.log(`\nsetting the proof server to ${PROOF}`);
await tap(`proof-server-${PROOF}-radio`, `${PROOF} proof server`);

console.log('\nsetting the node and indexer');
const fields = ui.locator('input:visible, textarea:visible');
const n = await fields.count().catch(() => 0);
console.log('  editable fields on the sheet:', n);
// Fill by index, then verify by reading back: a field that silently refuses
// input is the failure mode worth catching here.
const want = [target.node, target.indexer];
for (let i = 0; i < Math.min(n, want.length); i++) {
  const f = fields.nth(i);
  await f.click().catch(() => {});
  await f.fill('').catch(() => {});
  await f.fill(want[i]).catch(async () => {
    // Some builds ignore fill on a controlled input; typing lands.
    await f.type(want[i], { delay: 12 }).catch(() => {});
  });
  await sleep(800);
}
const typed = await readSheet();
console.log('after typing:', JSON.stringify(typed.inputs));

console.log('\nsaving');
const saved = await tap('save-configuration-button', 'Save configuration');
check('the sheet had a Save button', saved);
await sleep(6000);
await ui.screenshot({ path: `${OUT}/point-local-saved.png`, fullPage: true }).catch(() => {});

// The whole point: reopen from scratch and see whether it stuck.
console.log('\nreopening to see whether it persisted');
await open();
await openSheet();
const after = await readSheet();
console.log('after reload:', JSON.stringify(after));
await ui.screenshot({ path: `${OUT}/point-local-after.png`, fullPage: true }).catch(() => {});

check(`proof server is ${PROOF}`, PROOF === 'local' ? after.local === true : after.remote === true,
  `local=${after.local} remote=${after.remote}`);
check('node address persisted', String(after.node ?? '').includes(target.node.replace(/^https?:\/\//, '')),
  `${after.node} want ${target.node}`);
check('indexer address persisted', String(after.indexer ?? '').includes(target.indexer.replace(/^https?:\/\//, '')),
  `${after.indexer} want ${target.indexer}`);

await ctx.close().catch(() => {});
console.log(`\n${failures === 0 ? 'Lace is pointed at the requested network' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
