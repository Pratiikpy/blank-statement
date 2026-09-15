// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Turn the fixture wallet's NIGHT into the DUST that pays transaction fees.
//
// On Midnight, DUST is generated over time from NIGHT that has been *designated*
// for it. A wallet holding NIGHT but designating none has a DUST tank reading
// 0/0 and cannot send anything at all, which is the state every freshly funded
// wallet is in. midday cannot do this for a browser wallet ("the Lace DApp
// Connector does not expose programmatic DUST registration"), so it has to go
// through Lace's own screen.
//
// Run tests/fund-address.mjs first, or there is nothing to designate.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-profile';
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
const extId = sw ? new URL(sw.url()).host : 'hgeekaiplokcnmakghbdfbgnlfheichg';

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1000 });
await ui.goto(`chrome-extension://${extId}/tab.html`, { waitUntil: 'domcontentloaded' });
await sleep(12000);
const pw = ui.locator('input[type="password"]').first();
if (await pw.count().catch(() => 0)) {
  await pw.fill(PASSWORD).catch(() => {});
  await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}

const read = async () => (await ui.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ');
  return {
    tank: (t.match(/tDUST Tank ([\d,./ ]+) tDUST/) ?? [])[1]?.trim() ?? null,
    designation: (t.match(/Amount: ?([\d,./]+)/) ?? [])[1] ?? null,
    night: (t.match(/NIGHT tNIGHT ([\d,.]+)/) ?? [])[1] ?? null,
    fill: (t.match(/Fill time: ([^ ]+)/) ?? [])[1] ?? null,
  };
}).catch(() => ({})));

console.log('before:', JSON.stringify(await read()));

const gen = ui.locator('button:has-text("Generate tDUST"), [role="button"]:has-text("Generate tDUST")').first();
const enabled = await gen.isEnabled().catch(() => false);
console.log('\n"Generate tDUST" enabled:', enabled);
if (!enabled) {
  console.log('nothing to designate; run tests/fund-address.mjs first');
  await ctx.close().catch(() => {});
  process.exit(2);
}

await gen.click().catch((e) => console.log('click threw:', e.message.slice(0, 70)));
await sleep(5000);
console.log('dialog:', await ui.evaluate(
  () => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)).catch(() => ''));
await ui.screenshot({ path: `${OUT}/lace-dust-dialog.png`, fullPage: true }).catch(() => {});

const controls = await ui.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return {
    buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .map((b) => (b.innerText || '').trim().slice(0, 26)).filter(Boolean),
    inputs: [...document.querySelectorAll('input')].filter(vis)
      .map((i) => ({ type: i.type, testid: i.getAttribute('data-testid'), value: i.value.slice(0, 20) })),
  };
}).catch(() => ({}));
console.log('controls:', JSON.stringify(controls).slice(0, 400));

// "Generate tDUST" opens Lace's ordinary send form, pre-addressed to this
// wallet's own dust address. It needs an amount before the review button does
// anything, so fill every amount-looking field with the NIGHT on hand.
const nightHeld = (await read()).night?.replace(/,/g, '') ?? '1000';
console.log('  designating:', nightHeld);

const fields = await ui.evaluate(() => [...document.querySelectorAll('input')].map((i, n) => ({
  n, type: i.type, testid: i.getAttribute('data-testid'), name: i.name,
  ph: i.placeholder, value: i.value.slice(0, 24),
})));
console.log('  all inputs:', JSON.stringify(fields).slice(0, 500));

const amountSel = 'input[data-testid*="amount"], input[name*="amount"], input[placeholder*="mount"]';
const amount = ui.locator(amountSel).first();
if (await amount.count().catch(() => 0)) {
  await amount.fill(nightHeld).catch((e) => console.log('  amount fill threw:', e.message.slice(0, 60)));
  await sleep(2500);
  console.log('  amount set');
} else {
  console.log('  no amount field found by selector; trying the second text input');
  const second = ui.locator('input[type="text"]').nth(1);
  if (await second.count().catch(() => 0)) { await second.fill(nightHeld).catch(() => {}); await sleep(2000); }
}
await ui.screenshot({ path: `${OUT}/lace-dust-form.png`, fullPage: true }).catch(() => {});

for (const label of ['Review transaction', 'Confirm', 'Continue', 'Send', 'Generate tDUST']) {
  const b = ui.locator(`button:has-text("${label}")`).first();
  if (!(await b.count().catch(() => 0))) continue;
  if (!(await b.isEnabled().catch(() => false))) { console.log(`  "${label}" is disabled`); continue; }
  console.log('  pressing', label);
  await b.click().catch(() => {});
  await sleep(7000);
  const p = ui.locator('input[type="password"]').first();
  if (await p.count().catch(() => 0)) {
    console.log('  entering password');
    await p.fill(PASSWORD).catch(() => {});
    await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
  console.log('    screen:', (await ui.evaluate(
    () => document.body.innerText.replace(/\s+/g, ' ').slice(-220)).catch(() => '')));
}
await ui.screenshot({ path: `${OUT}/lace-dust-after.png`, fullPage: true }).catch(() => {});
console.log('\nafter the dialog:', JSON.stringify(await read()));

// DUST accrues per block once designated, so it will not be instant.
for (const wait of [20000, 30000, 45000]) {
  await sleep(wait);
  const r = await read();
  console.log(`  +${Math.round(wait / 1000)}s:`, JSON.stringify(r));
  if (r.tank && !/^0 \/ 0/.test(r.tank)) { console.log('\nthe tank is filling'); break; }
}
await ui.screenshot({ path: `${OUT}/lace-dust-final.png`, fullPage: true }).catch(() => {});

await ctx.close().catch(() => {});
process.exit(0);
