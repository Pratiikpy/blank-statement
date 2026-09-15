// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What is actually on Lace's settings screen?
//
// Settings opens as an overlay on top of the wallet, so a truncated dump of
// test ids shows the wallet underneath and none of the settings rows. This
// prints every row on the settings surface, and every row one level in, so the
// path to a given setting can be named rather than guessed at.
//
//   node tests/lace-settings-map.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24';
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = null;
for (let i = 0; i < 15 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await sleep(1000); }
const extId = new URL(sw.url()).host;

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
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

// Only rows in the right-hand overlay: the wallet behind it has its own ids
// and including them is what buried the settings rows last time.
const rows = () => ui.evaluate(() => {
  const w = window.innerWidth;
  return [...document.querySelectorAll('[data-testid]')]
    .map((e) => { const r = e.getBoundingClientRect(); return { e, r }; })
    .filter(({ r }) => r.width > 40 && r.height > 10 && r.left > w * 0.4)
    .map(({ e, r }) => ({
      id: e.getAttribute('data-testid'),
      label: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      y: Math.round(r.top),
    }))
    .filter((x) => x.label)
    .slice(0, 80);
}).catch(() => []);
const tap = async (id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  await el.click({ timeout: 12000 }).catch(() => {});
  await sleep(3500);
  return true;
};

await tap('settings-tab-btn');
console.log('settings rows:');
const top = await rows();
for (const r of top) console.log(`   ${r.id}  ::  ${r.label}`);
await ui.screenshot({ path: `${OUT}/settings-top.png`, fullPage: true }).catch(() => {});

// Walk into each option row and print what it holds, then come back.
const options = [...new Set(top.filter((r) => /^option-list-item-/.test(r.id)).map((r) => r.id))];
console.log('\noption rows to open:', JSON.stringify(options));
for (const id of options) {
  await tap(id);
  const inner = await rows();
  console.log(`\n-- ${id} --`);
  for (const r of inner.slice(0, 30)) console.log(`   ${r.id}  ::  ${r.label}`);
  const text = await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(-500)).catch(() => '');
  console.log('   text tail:', String(text).slice(-300));
  await ui.screenshot({ path: `${OUT}/settings-${id}.png`, fullPage: true }).catch(() => {});
  // Back out to the settings list for the next row.
  await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(9000);
  await tap('settings-tab-btn');
}

await ctx.close().catch(() => {});
process.exit(0);
