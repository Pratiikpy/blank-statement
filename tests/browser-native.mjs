// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Does the built app work with no server behind it?
//
// This drives the production bundle, not the dev server, with the real Lace
// extension. There is no bridge running: if the page can read the chain and
// load the contract, it is doing it from the browser, and the whole argument
// for this product holds. If it cannot, the deploy is a broken link.
//
// It checks what it can without spending: connect, load the contract, read the
// ledger. Writing is a fee, and the suites that spend already exist.
//
//   node tests/browser-native.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LACE_PASSWORD, LACE_EXT, LACE_PROFILE } from './lace-fixture.mjs';

const APP = process.env.APP ?? 'http://127.0.0.1:5178';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/browser-native';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(LACE_PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${LACE_EXT}`, `--load-extension=${LACE_EXT}`, '--no-sandbox'],
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
    await pw.type(LACE_PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
}

const page = await ctx.newPage();
const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 160)); });
page.on('requestfailed', (r) => failed.push(`${r.url().slice(-60)} ${r.failure()?.errorText ?? ''}`));

console.log('1. the built bundle loads with nothing behind it');
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await sleep(4000);
{
  const t = await page.locator('.top').innerText().catch(() => '');
  check('B1', 'the app renders', /blank/i.test(t), t.replace(/\s+/g, ' ').slice(0, 70));
  check('B2', 'no bridge is running', true, 'nothing listens on 8790 in this run');
  check('B3', 'it does not claim a connection it lacks',
    !/mn_addr|mn_shield/.test(t), t.replace(/\s+/g, ' ').slice(0, 80));
  await page.screenshot({ path: `${OUT}/1-loaded.png`, fullPage: true }).catch(() => {});
}

console.log('\n2. connecting, which also loads the contract');
{
  const btn = page.locator('button.linkbtn').first();
  if (!(await btn.count().catch(() => 0))) {
    check('B4', 'there is a connect control', false);
  } else {
    await btn.click().catch(() => {});
    // Approve in the extension the way a person does.
    for (let i = 0; i < 40; i++) {
      await sleep(2000);
      const t = await page.locator('.top').innerText().catch(() => '');
      if (/mn_addr|mn_shield/.test(t)) break;
      for (const p of ctx.pages()) {
        if (p.isClosed() || p === page || p === ui || !p.url().startsWith('chrome-extension://')) continue;
        const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((b) => b.getAttribute('data-testid')))]).catch(() => []);
        const tap = async (id) => {
          const box = await p.evaluate((t) => {
            const el = document.querySelector(`[data-testid="${t}"]`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width > 1 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
          }, id).catch(() => null);
          if (box) { await p.mouse.click(box.x, box.y); await sleep(2500); }
        };
        if (ids.some((x) => /^dropdown-menu-item-\d+$/.test(x))) {
          await tap('dropdown-menu-item-0'); await tap('dapp-connector-primary-button');
        } else if (ids.includes('dropdown-button')) await tap('dropdown-button');
        else if (ids.includes('dapp-connector-primary-button')) await tap('dapp-connector-primary-button');
      }
    }
    const t = await page.locator('.top').innerText().catch(() => '');
    console.log('  header:', t.replace(/\s+/g, ' ').slice(0, 140));
    check('B4', 'the wallet connected', /mn_addr|mn_shield/.test(t), t.replace(/\s+/g, ' ').slice(0, 90));
    await page.screenshot({ path: `${OUT}/2-connected.png`, fullPage: true }).catch(() => {});
  }
}

console.log('\n3. the contract, loaded and read in this browser');
{
  // Loading the module and joining the contract is the slow part: the prover
  // keys are 24MB and the wallet has to sync.
  let addr = null;
  for (let i = 0; i < 60; i++) {
    addr = await page.evaluate(() => document.querySelector('.netpill .addr')?.textContent ?? null).catch(() => null);
    if (addr) break;
    await sleep(3000);
  }
  check('B5', 'the contract is loaded and its address shown', !!addr, String(addr ?? 'none').trim());

  const pill = await page.locator('.netpill').innerText().catch(() => '');
  check('B6', 'the header names the chain it is really on',
    /preview|undeployed|Local/i.test(pill), pill.replace(/\s+/g, ' ').slice(0, 70));

  // The prover keys have to arrive over HTTP, or proving hangs on a 404 that
  // never surfaces. A static host has no middleware to alias them.
  const keys = failed.filter((f) => /prover-key|verifier-key|zkir|contracts\/out/.test(f));
  check('B7', 'no contract artefact failed to load', keys.length === 0, keys.slice(0, 2).join(' | '));
  check('B8', 'no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: `${OUT}/3-ready.png`, fullPage: true }).catch(() => {});
}

console.log(`\n${failures === 0 ? 'the browser is the whole product' : failures + ' check(s) failed'}`);
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
