// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Press the app's own "Connect wallet" button, with the real Lace extension.
//
// Every other wallet test reaches around this button. `wallet-states.mjs`
// presses it with a connector I wrote, which proves the copy and nothing about
// Lace. `wallet-write-relay.mjs` uses the real extension but goes through
// `wallet-write.html`, a bench, not the product. So the one control a person
// actually presses to connect their wallet to this app had never been pressed
// with a real wallet behind it.
//
// This opens the app in a browser carrying the real extension, presses the
// button, approves in the extension window the way a person does, and then
// checks what the header says against what the wallet actually holds.
//
//   node tests/app-connect-lace.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/app-connect';
const PASSWORD = LACE_PASSWORD;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
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

// The connector answers "locked" for everything until the extension is
// unlocked, and a page cannot do that itself.
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
page.on('pageerror', (e) => errors.push(String(e).slice(0, 150)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 150)); });
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await sleep(4000);

const header = () => page.locator('.top').innerText().catch(() => '');
console.log('1. before pressing anything');
{
  const t = await header();
  console.log('  ' + t.replace(/\s+/g, ' ').slice(0, 130));
  check('K1', 'the app notices the real extension',
    !/No Midnight wallet in this browser/i.test(t), t.replace(/\s+/g, ' ').slice(0, 100));
  check('K2', 'and offers to connect',
    await page.locator('button.linkbtn').count() > 0);
  check('K3', 'without claiming a connection it does not have',
    !/mn_addr|mn_shield/.test(t), t.replace(/\s+/g, ' ').slice(0, 100));
  await page.screenshot({ path: `${OUT}/1-before.png`, fullPage: true }).catch(() => {});
}

console.log('\n2. pressing "Connect wallet"');
// Not awaited: pressing it raises an approval window in the extension, and
// awaiting here would block the code that has to answer it.
await page.locator('button.linkbtn').first().click().catch((e) => console.log('  click:', e.message.slice(0, 60)));

const tapIn = async (p, id) => {
  const box = await p.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, id).catch(() => null);
  if (!box) return false;
  console.log('  approving: tapping', id);
  await p.mouse.click(box.x, box.y);
  await sleep(2500);
  return true;
};

// Answer whatever the extension raises, the way a person clicking through it
// would: pick the account, then authorise.
for (let i = 0; i < 40; i++) {
  await sleep(2000);
  const t = await header();
  if (/mn_addr|mn_shield/.test(t)) break;
  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || p === ui || !p.url().startsWith('chrome-extension://')) continue;
    const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
    if (!ids.length) continue;
    if (ids.some((x) => /^dropdown-menu-item-\d+$/.test(x))) {
      await tapIn(p, 'dropdown-menu-item-0');
      await tapIn(p, 'dapp-connector-primary-button');
    } else if (ids.includes('dropdown-button')) {
      await tapIn(p, 'dropdown-button');
    } else if (ids.includes('dapp-connector-primary-button')) {
      await tapIn(p, 'dapp-connector-primary-button');
    }
  }
}

console.log('\n3. what the app says now');
{
  const t = await header();
  console.log('  ' + t.replace(/\s+/g, ' ').slice(0, 180));
  await page.screenshot({ path: `${OUT}/2-connected.png`, fullPage: true }).catch(() => {});

  check('K4', 'the app shows the connected address',
    /mn_addr|mn_shield/.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  check('K5', 'it names the wallet and its connector version',
    /lace/i.test(t) && /4\.0\.1/.test(t), t.replace(/\s+/g, ' ').slice(0, 110));
  // The header must not still be inviting a connection it already has.
  check('K6', 'the connect button is gone once connected',
    (await page.locator('button.linkbtn').count()) === 0,
    String(await page.locator('button.linkbtn').count()));

  // The address on screen has to be the wallet's real address, not a
  // placeholder. Read it back from the connector itself.
  const real = await page.evaluate(async () => {
    const key = Object.keys(window.midnight ?? {})[0];
    if (!key) return null;
    try {
      const s = await window.midnight[key].connect('undeployed');
      const { unshieldedAddress } = await s.getUnshieldedAddress();
      return unshieldedAddress;
    } catch (e) { return 'ERR ' + String(e?.message ?? e).slice(0, 60); }
  }).catch(() => null);
  console.log('  the wallet itself says:', String(real).slice(0, 46), '…');
  const shown = (t.match(/mn_[a-z-]*addr[^\s…]*/) ?? [''])[0].replace(/…$/, '');
  check('K7', 'the address shown is the wallet\'s own',
    !!real && !String(real).startsWith('ERR') && String(real).startsWith(shown.slice(0, 18)),
    `screen ${shown.slice(0, 24)} vs wallet ${String(real).slice(0, 24)}`);

  // The product is honest that connecting a wallet has not moved proving yet.
  check('K8', 'it does not overstate what connecting achieves',
    /proving still|bridge/i.test(t) || !/your key/i.test(t),
    t.replace(/\s+/g, ' ').slice(0, 120));
  check('K9', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
}

console.log('\n4. the connection survives moving around the app');
{
  await page.getByRole('tab', { name: 'Asking' }).click().catch(() => {});
  await sleep(1500);
  const t1 = await header();
  check('K10', 'still connected on another tab', /mn_addr|mn_shield/.test(t1),
    t1.replace(/\s+/g, ' ').slice(0, 90));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(6000);
  const t2 = await header();
  // Either answer is defensible; what matters is that it is not a lie.
  const stillShown = /mn_addr|mn_shield/.test(t2);
  console.log(`  after a reload the header ${stillShown ? 'still shows' : 'no longer shows'} the address`);
  check('K11', 'after a reload the header is honest either way',
    stillShown ? true : /Connect wallet|No wallet/i.test(t2),
    t2.replace(/\s+/g, ' ').slice(0, 100));
  await page.screenshot({ path: `${OUT}/3-after-reload.png`, fullPage: true }).catch(() => {});
}

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
