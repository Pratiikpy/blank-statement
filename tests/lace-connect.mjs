// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Connect the app to a real Lace wallet that has an account, on the local
// `undeployed` network. Run tests/lace-onboard.mjs first; this reuses the
// profile it leaves behind.
//
// Unlike tests/lace.mjs, which proves the app behaves when the wallet has no
// account, this one goes through the authorization prompt and reads back what
// the session actually hands over.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-profile';
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
const sw = ctx.serviceWorkers()[0];
const extId = sw ? new URL(sw.url()).host : 'hgeekaiplokcnmakghbdfbgnlfheichg';
console.log('extension enabled, workers:', ctx.serviceWorkers().length);

// --- the wallet's own view, and its address ---------------------------------
const ui = await ctx.newPage();
await ui.goto(`chrome-extension://${extId}/tab.html`, { waitUntil: 'domcontentloaded' });
await sleep(9000);

// A relaunched profile may be locked.
const pw = ui.locator('input[type="password"]').first();
if (await pw.count().catch(() => 0)) {
  console.log('wallet is locked, unlocking');
  await pw.fill(PASSWORD).catch(() => {});
  await ui.locator('button:has-text("Unlock"), [data-testid*="unlock"]').first().click().catch(() => {});
  await sleep(7000);
}
console.log('wallet screen:', (await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '')));

let address = null;
const receive = ui.locator('button:has-text("Receive"), [data-testid*="receive"]').first();
if (await receive.count().catch(() => 0)) {
  await receive.click().catch(() => {});
  await sleep(5000);
  address = await ui.evaluate(() => {
    const m = document.body.innerText.match(/\b(mn_shield-addr[a-z0-9_]*[a-z0-9]{20,}|[0-9a-f]{60,})\b/i);
    return m ? m[0] : null;
  }).catch(() => null);
  await ui.screenshot({ path: `${OUT}/lace-receive.png` }).catch(() => {});
}
console.log('address from the wallet UI:', address ? address.slice(0, 46) + '…' : 'not found');

// --- connect from the app ---------------------------------------------------
const page = await ctx.newPage();
for (let i = 0; i < 6; i++) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('.tab', { timeout: 30000 }).catch(() => {});
  await sleep(6000);
  if (await page.evaluate(() => !!window.midnight).catch(() => false)) break;
}
console.log('\nconnector present:', await page.evaluate(() => !!window.midnight));
console.log('pill before:', JSON.stringify(await page.evaluate(
  () => document.querySelector('.walletpill')?.textContent.trim().slice(0, 70))));

await page.locator('.walletpill .linkbtn').first().click().catch((e) =>
  console.log('click threw:', e.message.slice(0, 70)));

// The authorization prompt is a separate extension window.
let approved = false;
for (let i = 0; i < 12 && !approved; i++) {
  await sleep(2500);
  for (const p of ctx.pages()) {
    if (p.isClosed() || !p.url().startsWith('chrome-extension://') || p === ui) continue;
    const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
    if (!/authori|connect|allow|permission/i.test(text)) continue;
    console.log('\nauthorization prompt:', JSON.stringify(text.slice(0, 160)));
    await p.screenshot({ path: `${OUT}/lace-authorize.png` }).catch(() => {});
    const btns = await p.evaluate(() => [...document.querySelectorAll('button,[role="button"]')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => b.getAttribute('data-testid') || b.innerText.trim().slice(0, 24))).catch(() => []);
    console.log('  buttons:', JSON.stringify(btns));
    const go = p.locator('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Connect"), [data-testid*="authorize"], [data-testid*="allow"]').first();
    if (await go.count().catch(() => 0)) {
      await go.click().catch((e) => console.log('  approve threw:', e.message.slice(0, 60)));
      approved = true;
      await sleep(6000);
    }
  }
}
console.log('approved in the wallet:', approved);

await sleep(10000);
const after = await page.evaluate(() => ({
  pill: document.querySelector('.walletpill')?.textContent.trim().slice(0, 160),
  note: document.querySelector('.walletnote')?.textContent?.trim().slice(0, 160) ?? null,
  dot: document.querySelector('.walletpill .dot')?.className,
})).catch(() => ({ pill: '(gone)' }));
console.log('\npill after :', JSON.stringify(after.pill));
console.log('note after :', JSON.stringify(after.note));
console.log('dot  after :', after.dot);
await page.screenshot({ path: `${OUT}/lace-connected.png` }).catch(() => {});

// What the session actually hands over, read directly from the connector.
const session = await page.evaluate(async () => {
  try {
    const k = Object.keys(window.midnight)[0];
    const s = await window.midnight[k].connect('undeployed');
    if (!s) return { ok: false, why: 'no session' };
    const out = { ok: true, methods: Object.keys(s).concat(
      Object.getOwnPropertyNames(Object.getPrototypeOf(s) ?? {})).filter((x) => x !== 'constructor') };
    if (typeof s.state === 'function') {
      const st = await s.state();
      out.address = st?.address ?? null;
      out.coinPublicKey = st?.coinPublicKey ?? null;
      out.stateKeys = Object.keys(st ?? {});
    }
    return out;
  } catch (e) {
    return { ok: false, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 140) };
  }
});
console.log('\nsession:', JSON.stringify(session, null, 1).slice(0, 900));

await ctx.close().catch(() => {});
process.exit(0);
