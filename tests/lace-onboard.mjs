// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Create a Lace wallet and point it at the local `undeployed` stack, so the app
// can be driven against a real Midnight wallet instead of the bridge's keys.
//
// This wallet is disposable by construction: it lives in a throwaway Chromium
// profile, its recovery phrase is generated here and never used anywhere else,
// and it only ever holds funds minted by a local dev chain that resets. It is a
// test fixture, not an account. Do not point this at a network that matters.
//
// Lace ships an `Undeployed` network whose defaults are exactly this stack:
//   node          http://localhost:9944
//   proof server  http://localhost:6300
//   indexer       http://localhost:8088/api/v3/graphql
// so "Configure Midnight", the third onboarding step, is the whole job.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-profile';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
// A local-only fixture password. It guards nothing of value and is written down
// here on purpose so the profile can be reopened by hand.
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(PROFILE, { recursive: true });

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

// Chrome keeps an unpacked extension disabled until developer mode is on, and a
// disabled extension's UI never runs at all.
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
const extId = sw ? new URL(sw.url()).host : EXT.split('-').pop();
console.log('extension enabled, workers:', ctx.serviceWorkers().length);

// The preview build serves its UI from tab.html; the main Lace extension uses
// expo/index.html. Try what is configured, then the ones that exist.
const UI_PAGES = (process.env.LACE_UI ? [process.env.LACE_UI] : [])
  .concat(['tab.html', 'expo/index.html', 'popup.html']);
const ui = await ctx.newPage();
let opened = null;
for (const path of UI_PAGES) {
  const r = await ui.goto(`chrome-extension://${extId}/${path}`, { waitUntil: 'domcontentloaded' })
    .catch(() => null);
  if (r && !ui.isClosed()) { opened = path; break; }
}
if (!opened) {
  console.log('could not open the wallet UI from any of', UI_PAGES.join(', '));
  await ctx.close().catch(() => {});
  process.exit(2);
}
console.log('wallet UI:', opened);
await sleep(12000);

const shot = (n) => ui.screenshot({ path: `${OUT}/lace-onboard-${n}.png` }).catch(() => {});
const screen = async () => (await ui.evaluate(
  () => document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)).catch(() => '(gone)'));
const tap = async (testid, label = testid) => {
  const el = ui.locator(`[data-testid="${testid}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`  no ${label}`); return false; }
  await el.click().catch((e) => console.log(`  ${label} click threw:`, e.message.slice(0, 60)));
  await sleep(4000);
  return true;
};

// Restoring rather than creating lets this point at a wallet the local chain
// already funded, which is the difference between a fixture that can pay fees
// and one that cannot.
const RESTORE = (process.env.RESTORE_PHRASE ?? '').trim();

console.log('\n1. welcome');
console.log('  ' + await screen());
await shot('1-welcome');
await tap(RESTORE ? 'restore-button' : 'create-button', RESTORE ? 'Restore' : 'Create');

if (RESTORE) {
  const given = RESTORE.split(/\s+/);
  console.log(`\n2. restoring from a ${given.length}-word phrase`);
  console.log('  ' + await screen());
  const count = await ui.evaluate(() => document.querySelectorAll(
    'input[data-testid="mnemonic-word-input"], input[id^="mnemonic-word-"]').length);
  console.log('  inputs on screen:', count);
  for (let i = 0; i < count; i++) {
    const el = ui.locator(`#mnemonic-word-${i + 1}`);
    if (await el.count().catch(() => 0)) await el.fill(given[i] ?? '').catch(() => {});
  }
  await sleep(2500);
  await shot('2-restore');
  await tap('wallet-setup-step-btn-next', 'Next');
  await sleep(3000);
}

// --- 2. the recovery phrase, read straight off the screen -------------------
const words = RESTORE ? RESTORE.split(/\s+/) : await ui.evaluate(() => {
  // Lace renders the phrase as numbered words. Prefer real inputs if it used
  // them, and fall back to parsing the visible "1. word 2. word" text.
  const inputs = [...document.querySelectorAll('input[data-testid="mnemonic-word-input"], input[id^="mnemonic-word-"]')];
  const fromInputs = inputs.map((i) => (i.value || '').trim()).filter(Boolean);
  if (fromInputs.length >= 12) return fromInputs;
  const text = document.body.innerText;
  const pairs = [...text.matchAll(/(\d{1,2})\.\s*([a-z]{3,})/g)];
  const byIndex = new Map();
  for (const [, n, w] of pairs) if (!byIndex.has(Number(n))) byIndex.set(Number(n), w);
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
});
if (!RESTORE) {
  console.log('\n2. recovery phrase');
  console.log('  ' + await screen());
  await shot('2-phrase');
}
console.log(`  phrase has ${words.length} words`);
if (words.length < 12) {
  console.log('  could not read the phrase; stopping rather than guessing');
  console.log('  screen was:', await screen());
  await ctx.close().catch(() => {});
  process.exit(2);
}
// Kept beside the profile, never in the repo: this is how the fixture wallet is
// reopened, and it is worthless outside this machine's local chain.
writeFileSync(`${PROFILE}/RECOVERY.txt`,
  `local test fixture only - do not reuse\n\n${words.join(' ')}\n\npassword: ${PASSWORD}\n`);
console.log('  phrase saved beside the profile (not in the repo)');

// --- 3. type it back. Restoring already did this on the way in. -------------
if (!RESTORE) {
  await tap('wallet-setup-step-btn-next', 'Next');
  console.log('\n3. confirming the phrase');
  console.log('  ' + await screen());
  const count = await ui.evaluate(() => document.querySelectorAll(
    'input[data-testid="mnemonic-word-input"], input[id^="mnemonic-word-"]').length);
  console.log('  inputs to fill:', count);
  for (let i = 0; i < count; i++) {
    const el = ui.locator(`#mnemonic-word-${i + 1}`);
    if (!(await el.count().catch(() => 0))) continue;
    await el.fill(words[i] ?? '').catch(() => {});
  }
  await sleep(2500);
  await shot('3-confirm');
  await tap('wallet-setup-step-btn-next', 'Next');
}

// --- 4. name and password ---------------------------------------------------
console.log('\n4. wallet setup');
console.log('  ' + await screen());
const fields = await ui.evaluate(() => [...document.querySelectorAll('input')]
  .filter((i) => i.offsetParent !== null)
  .map((i) => ({ id: i.id, testid: i.getAttribute('data-testid'), type: i.type, ph: i.placeholder })));
console.log('  fields:', JSON.stringify(fields).slice(0, 320));

for (const f of fields) {
  const sel = f.id ? `#${f.id}` : f.testid ? `[data-testid="${f.testid}"]` : null;
  if (!sel) continue;
  const value = f.type === 'password' ? PASSWORD : 'blank-statement-local';
  await ui.locator(sel).first().fill(value).catch(() => {});
}
await sleep(2000);
await shot('4-setup');
await tap('wallet-setup-step-btn-next', 'Next');
await sleep(4000);

// --- 5. Configure Midnight --------------------------------------------------
console.log('\n5. configure midnight');
console.log('  ' + await screen());
await shot('5-configure');
const options = await ui.evaluate(() => {
  const vis = (el) => el.offsetParent !== null;
  return {
    selects: [...document.querySelectorAll('select')].filter(vis).map((s) => ({
      id: s.id, options: [...s.options].map((o) => o.value || o.textContent.trim()),
    })),
    inputs: [...document.querySelectorAll('input')].filter(vis).map((i) => ({
      id: i.id, testid: i.getAttribute('data-testid'), value: i.value.slice(0, 60), ph: i.placeholder,
    })),
    buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .map((b) => b.getAttribute('data-testid') || b.innerText.trim().slice(0, 30)).slice(0, 14),
  };
});
console.log('  ' + JSON.stringify(options).slice(0, 700));

// Undeployed, and the proof server on this machine rather than the hosted one.
await tap('radio-btn-test-id-undeployed', 'network: Undeployed');
await tap('radio-btn-test-id-http://localhost:6300', 'proof server: localhost:6300');

// Lace's Undeployed preset hard-codes the indexer at localhost:8088 and
// disables the field, so it cannot be pointed at this stack from here. On this
// machine 8088 belonged to an unrelated container on its own Docker network,
// which resolved `node:9944` to a different node: Lace would have submitted to
// our chain while reading balances from someone else's, and an empty wallet is
// what that looks like. scripts/lace-indexer-proxy.mjs forwards 8088 to the
// indexer this stack actually publishes, so the preset becomes correct instead
// of being fought.
const wired = await fetch('http://127.0.0.1:8088/api/v4/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{__typename}' }),
}).then((r) => r.ok).catch(() => false);
console.log('  indexer answering on 8088:', wired, wired ? '' : '<-- run scripts/lace-indexer-proxy.mjs');

const addresses = await ui.evaluate(() => ({
  node: document.querySelector('[data-testid="node-address-input"]')?.value ?? null,
  indexer: document.querySelector('[data-testid="indexer-address-input"]')?.value ?? null,
}));
console.log('  node   :', addresses.node);
console.log('  indexer:', addresses.indexer);
const local = /localhost:9944/.test(addresses.node ?? '') && /localhost:8088/.test(addresses.indexer ?? '');
console.log('  pointing at this stack:', local && wired);
await shot('5-configure');

await tap('wallet-setup-step-btn-next', 'Next');
await sleep(6000);

// --- 6. whatever it shows on the way out ------------------------------------
console.log('\n6. finishing');
for (let i = 0; i < 4; i++) {
  const text = await screen();
  console.log(`  ${text.slice(0, 120)}`);
  if (ui.isClosed()) break;
  if (/#\/(wallet|assets|home)/.test(ui.url()) || !/onboarding/.test(ui.url())) break;
  const next = ui.locator('[data-testid="wallet-setup-step-btn-next"], button:has-text("Go to my wallet"), button:has-text("Got it")').first();
  if (!(await next.count().catch(() => 0))) break;
  await next.click().catch(() => {});
  await sleep(5000);
}
await shot('6-wallet');
console.log('  landed on:', ui.isClosed() ? '(closed)' : ui.url().slice(-40));
console.log('  screen   :', await screen());

console.log('\nprofile kept at:', PROFILE);
console.log('screenshots in:', OUT);
await ctx.close().catch(() => {});
process.exit(0);
