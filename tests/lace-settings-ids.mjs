// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Every option row on Lace's settings screen, by test id.
//
// The rows carry their label in a child element, so filtering by innerText
// drops all of them and the settings page looks empty. This asks for the ids
// directly and reads each label from the row's subtree.
//
//   node tests/lace-settings-ids.mjs
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
await ui.locator('[data-testid="settings-tab-btn"]').first().click({ timeout: 12000 }).catch(() => {});
await sleep(5000);

// OPEN walks further in, one id per step: OPEN=option-list-item-account
for (const step of (process.env.OPEN ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const el = ui.locator(`[data-testid="${step}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log('no such row:', step); break; }
  await el.click({ timeout: 12000 }).then(() => console.log('opened', step)).catch(() => {});
  await sleep(5000);
}

// WIDE lists every row in the right-hand pane, for screens whose controls are
// not named after the settings list at all.
const dump = await ui.evaluate((wide) => {
  const all = [...document.querySelectorAll('[data-testid]')];
  const options = all.filter((e) => {
    const id = e.getAttribute('data-testid') ?? '';
    if (!wide) return /option-list-item|settings|security|recovery|passphrase|mnemonic/i.test(id);
    const r = e.getBoundingClientRect();
    return r.width > 20 && r.height > 10 && r.left > window.innerWidth * 0.33;
  });
  return options.map((e) => {
    const r = e.getBoundingClientRect();
    return {
      id: e.getAttribute('data-testid'),
      label: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
  });
}, process.env.WIDE === '1').catch(() => []);
console.log('settings option rows:');
for (const d of dump) console.log(`   ${d.id}  ::  ${d.label}  ::  ${JSON.stringify(d.box)}`);

// The full page text names rows that have no id of their own.
const text = await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
const idx = text.indexOf('Configure your Lace App');
console.log('\nsettings page text:');
console.log('   ' + (idx >= 0 ? text.slice(idx, idx + 700) : text.slice(-700)));
await ui.screenshot({ path: `${OUT}/settings-ids.png`, fullPage: true }).catch(() => {});
await ctx.close().catch(() => {});
process.exit(0);
