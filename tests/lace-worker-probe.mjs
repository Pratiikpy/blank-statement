// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Where does Lace actually run its wallet code, and can it be listened to?
//
// The Generate tDUST flow shows "generating zero-knowledge proof" while the
// local proof server records no request at all, so the wallet stalls before it
// ever proves. Finding the stall means reading the wallet's own log, and the
// first question is which execution context that log goes to: the extension
// page, a dedicated worker it spawns, or the background service worker.
//
//   node tests/lace-worker-probe.mjs
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = null;
for (let i = 0; i < 15 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await sleep(1000); }
const extId = new URL(sw.url()).host;
console.log('extension:', extId);

// Evaluating inside Lace's MV3 background worker takes the whole browser down
// with it, so the worker is watched from the outside only: its requests come
// through the context-level listeners below.
const ctxNet = [];
const interesting = (u) => /midnight\.network|:6300|:9944|rpc\.|indexer\.|proof|graphql/.test(u);
ctx.on('request', (r) => { if (interesting(r.url())) ctxNet.push('-> ' + r.method() + ' ' + r.url().slice(0, 105)); });
ctx.on('response', (r) => { if (interesting(r.url())) ctxNet.push('<- ' + r.status() + ' ' + r.url().slice(0, 105)); });
ctx.on('requestfailed', (r) => { if (interesting(r.url())) ctxNet.push('!! ' + r.url().slice(0, 105) + ' ' + (r.failure()?.errorText ?? '')); });

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
// Everything, not only errors: the stall may be announced at log level, and
// filtering to errors is how it stayed invisible until now.
const pageLog = [];
ui.on('console', (m) => pageLog.push(m.type() + ' | ' + m.text().slice(0, 300)));
ui.on('pageerror', (e) => pageLog.push('pageerror | ' + String(e).slice(0, 400)));
ui.on('worker', (w) => {
  pageLog.push('WORKER STARTED | ' + w.url().slice(0, 120));
  w.on('close', () => pageLog.push('WORKER CLOSED | ' + w.url().slice(0, 120)));
});
const net = [];
ui.on('request', (r) => net.push('-> ' + r.method() + ' ' + r.url().slice(0, 110)));
ui.on('response', (r) => net.push('<- ' + r.status() + ' ' + r.url().slice(0, 110)));
ui.on('requestfailed', (r) => net.push('!! ' + r.url().slice(0, 110) + ' ' + (r.failure()?.errorText ?? '')));

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

console.log('\n2. execution contexts after unlock');
console.log('   service workers:', ctx.serviceWorkers().map((w) => w.url().slice(0, 90)));
console.log('   page workers   :', ui.workers().map((w) => w.url().slice(0, 90)));
console.log('   pages          :', ctx.pages().map((p) => p.url().slice(0, 90)));

console.log('\n3. driving Generate tDUST');
pageLog.length = 0;
net.length = 0;
const tap = async (id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log('   no', id); return false; }
  await el.click({ timeout: 15000 }).then(() => console.log('   tap', id))
    .catch((e) => console.log('   ' + id + ' failed: ' + e.message.split('\n')[0].slice(0, 80)));
  await sleep(4000);
  return true;
};
await tap('account-card-generate-dust-button');
await tap('designate-button');
await sleep(5000);

// Review step: fill the password, then press the panel's own confirm exactly
// once. Retyping into an already-filled field is what made earlier runs look
// like they were stuck on the password.
const pwHere = ui.locator('input[type="password"]:visible').first();
if (await pwHere.count().catch(() => 0)) {
  console.log('   password prompt on review');
  await pwHere.click().catch(() => {});
  await pwHere.fill('').catch(() => {});
  await pwHere.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const confirm = ui.locator('[data-testid="designate-button"], [data-testid*="confirm"]').first();
  if (await confirm.count().catch(() => 0)) {
    console.log('   confirming');
    await confirm.click({ timeout: 15000 }).catch((e) => console.log('   confirm: ' + e.message.split('\n')[0].slice(0, 70)));
  } else {
    await ui.keyboard.press('Enter').catch(() => {});
  }
}

for (let i = 1; i <= 6; i++) {
  await sleep(10000);
  const t = await ui.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
  console.log(`   +${i * 10}s screen: ${t.slice(0, 150)}`);
}

console.log('\n4. what the wallet said');
if (!pageLog.length) console.log('   (page console said nothing at all)');
for (const l of pageLog.slice(0, 60)) console.log('   ' + l);

console.log('\n5. what the wallet asked for');
const seen = [...new Set(net)].filter((u) => !/\.(png|svg|woff2?|css|js)\b/.test(u));
if (!seen.length) console.log('   (no network at all)');
for (const l of seen.slice(0, 50)) console.log('   ' + l);

console.log('\n6. what the background worker asked for');
const bg = [...new Set(ctxNet)];
if (!bg.length) console.log('   (the worker made no chain or proof request)');
for (const l of bg.slice(0, 50)) console.log('   ' + l);

console.log('\n7. workers now:', ui.workers().map((w) => w.url().slice(0, 90)));
await ctx.close().catch(() => {});
process.exit(0);
