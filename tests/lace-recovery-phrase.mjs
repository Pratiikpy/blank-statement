// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Read this profile's recovery phrase out of Lace and save it beside the
// profile, so the same wallet can be opened from Node.
//
// Lace's own Generate tDUST flow does not land: the panel shows "generating
// zero-knowledge proof" while the local proof server records no request at
// all, and the production build logs nothing, so there is no error to read.
// Midnight documents the same operation through the wallet SDK, and midday
// exposes it as registerDust(). Running it from Node needs the seed, and Lace
// derives its keys from this phrase, so the phrase reopens the same wallet
// that already holds the tNIGHT.
//
// This is a disposable local test wallet holding testnet tNIGHT, created by
// this repo's own onboarding script with a password kept in this repo.
//
// The path was mapped by tests/lace-settings-ids.mjs:
//   Settings > Account management > (wallet) Settings > Recovery phrase
//   verification > password > Show recovery phrase
//
//   node tests/lace-recovery-phrase.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
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
if (!sw) { console.log('the extension never started'); await ctx.close(); process.exit(2); }
const extId = new URL(sw.url()).host;

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(12000);

const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log('  no', what); return false; }
  await el.click({ timeout: 15000 }).then(() => console.log('  tap', what))
    .catch((e) => console.log('  ' + what + ': ' + e.message.split('\n')[0].slice(0, 70)));
  await sleep(4000);
  return true;
};

// The unlock screen uses a plain password input; the reveal gate uses a named
// prompt. Handle both.
const unlock = async () => {
  const pw = ui.locator('input[type="password"]:visible').first();
  if (!(await pw.count().catch(() => 0))) return false;
  console.log('  unlocking');
  await pw.click().catch(() => {});
  await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
  return true;
};
await unlock();

console.log('walking to the recovery phrase');
await tap('settings-tab-btn', 'Settings');
await tap('option-list-item-account', 'Account management');
await tap('wallet-hierarchy-action-button', 'wallet Settings');
await tap('wallet-settings-recovery-phrase-critical', 'Recovery phrase verification');

// The reveal is gated by the password, in its own prompt.
const prompt = ui.locator('[data-testid="authentication-prompt-input"] input, [data-testid="authentication-prompt-input"]').first();
if (await prompt.count().catch(() => 0)) {
  console.log('  password prompt');
  await prompt.click().catch(() => {});
  await ui.keyboard.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  await tap('authentication-prompt-button-confirm', 'Confirm');
  await sleep(5000);
}

await tap('recovery-phrase-show-button', 'Show recovery phrase');
await sleep(4000);

const found = await ui.evaluate(() => {
  const text = document.body.innerText.replace(/\s+/g, ' ').trim();
  // The list renders as "01. strong 02. gloom ...", so the separator after the
  // number is part of the pattern; without it nothing matches at all.
  const byIndex = new Map();
  for (const m of text.matchAll(/\b(\d{1,2})[.):]?\s+([a-z]{3,8})\b/g)) {
    const i = Number(m[1]);
    if (i >= 1 && i <= 24 && !byIndex.has(i)) byIndex.set(i, m[2]);
  }
  const ordered = [];
  for (let i = 1; i <= 24; i++) { if (byIndex.has(i)) ordered.push(byIndex.get(i)); else break; }
  const inputs = [...document.querySelectorAll('input')]
    .map((i) => i.value).filter((v) => /^[a-z]{3,8}$/.test(v ?? ''));
  const run = (text.match(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/) ?? [])[0] ?? null;
  return { ordered, inputs, run, tail: text.slice(-400) };
}).catch(() => ({}));

await ui.screenshot({ path: `${OUT}/recovery-phrase-screen.png`, fullPage: true }).catch(() => {});

let phrase = null;
if ((found.ordered ?? []).length >= 12) phrase = found.ordered.join(' ');
else if ((found.inputs ?? []).length >= 12) phrase = found.inputs.join(' ');
else if (found.run && found.run.split(/\s+/).length >= 12) phrase = found.run;

console.log('\nnumbered words:', (found.ordered ?? []).length);
console.log('input words   :', (found.inputs ?? []).length);
if (!phrase) {
  console.log('screen tail:', String(found.tail ?? '').slice(-300));
  const seen = await ui.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.left > window.innerWidth * 0.33; })
    .map((e) => e.getAttribute('data-testid')))]).catch(() => []);
  console.log('ids here:', JSON.stringify(seen).slice(0, 800));
  await ctx.close().catch(() => {});
  process.exit(3);
}

const words = phrase.split(/\s+/);
console.log(`\nphrase found: ${words.length} words, first "${words[0]}", last "${words[words.length - 1]}"`);
writeFileSync(`${PROFILE}/RECOVERY.txt`,
  `local test fixture only, disposable testnet wallet\n\n${phrase}\n`);
console.log('saved to', `${PROFILE}/RECOVERY.txt`);
await ctx.close().catch(() => {});
process.exit(0);
