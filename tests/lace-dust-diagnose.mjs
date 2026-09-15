// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Why does Lace's Generate tDUST reach "generating zero-knowledge proof" and
// then stop?
//
// Every previous attempt watched the wallet's PAGE. The wallet does its
// proving and submitting in its service worker, so the page stays silent and
// the failure looks like the button doing nothing. This attaches to the
// service worker itself, records its console and its fetches from inside, then
// runs the flow and reads the recording back.
//
// It also prints the proof server setting first, because a wallet on preview
// pointed at the local proof server would hang in exactly this way.
//
//   node tests/lace-dust-diagnose.mjs
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
// This profile already carries developer mode and the extension enabled, so
// the chrome://extensions toggle dance earlier scripts do is not only
// unnecessary here, it reloads the extension mid-run and takes the browser
// down with it. Just wait for the worker the extension starts on its own.
let sw = null;
for (let i = 0; i < 15 && !sw; i++) {
  sw = ctx.serviceWorkers()[0] ?? null;
  if (!sw) await sleep(1000);
}
if (!sw) {
  console.log('the extension never started a service worker');
  await ctx.close().catch(() => {});
  process.exit(2);
}
const extId = new URL(sw.url()).host;
console.log('extension:', extId);

// Record from inside the worker. Console events are not delivered for
// extension service workers, but code evaluated in the worker can install its
// own recorder and hand it back later.
const INSTRUMENT = `() => {
  if (self.__rec) return 'already';
  self.__rec = [];
  const push = (s) => { if (self.__rec.length < 900) self.__rec.push(s); };
  const render = (x) => {
    if (x instanceof Error) return x.name + ': ' + x.message;
    if (typeof x === 'object' && x !== null) { try { return JSON.stringify(x).slice(0, 300); } catch (e) { return String(x); } }
    return String(x);
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...a) => {
      try { push(level + ' | ' + a.map(render).join(' ').slice(0, 400)); } catch (e) {}
      return original(...a);
    };
  }
  const realFetch = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url)).slice(0, 120);
    push('fetch -> ' + ((init && init.method) || 'GET') + ' ' + url);
    try {
      const r = await realFetch(input, init);
      push('fetch <- ' + r.status + ' ' + url);
      return r;
    } catch (e) {
      push('fetch !! ' + url + ' ' + String(e && e.message).slice(0, 160));
      throw e;
    }
  };
  self.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push('unhandledrejection | ' + String((r && (r.stack || r.message)) || r).slice(0, 400));
  });
  self.addEventListener('error', (e) => push('error | ' + String(e.message).slice(0, 300)));
  return 'installed';
}`;

const arm = async () => {
  sw = ctx.serviceWorkers()[0];
  if (!sw) return 'no worker';
  return sw.evaluate(INSTRUMENT).catch((e) => 'failed: ' + e.message.slice(0, 80));
};
console.log('service worker recorder:', await arm());
// A worker that restarts loses the patch, so re-arm whenever a new one starts.
ctx.on('serviceworker', async (w) => { sw = w; await w.evaluate(INSTRUMENT).catch(() => {}); });

const dump = async (label) => {
  const rows = sw ? await sw.evaluate(() => (self.__rec || []).splice(0)).catch(() => []) : [];
  if (!rows.length) return;
  console.log(`\n--- service worker: ${label} (${rows.length}) ---`);
  for (const r of rows) console.log('   ' + r);
};

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(12000);

const pw = ui.locator('input[type="password"]:visible').first();
if (await pw.count().catch(() => 0)) {
  console.log('unlocking');
  await pw.click().catch(() => {});
  await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}
await arm();

const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`  no ${what}`); return false; }
  await el.click({ timeout: 15000 }).then(() => console.log('  tap', what))
    .catch((e) => console.log(`  ${what} click failed: ` + e.message.split('\n')[0].slice(0, 90)));
  await sleep(4000);
  return true;
};

// 1. What is the wallet actually configured to prove against?
console.log('\n1. settings');
await tap('settings-tab-btn', 'Settings');
await tap('option-list-item-midnight', 'Midnight');
const setting = await ui.evaluate(() => ({
  local: !!document.querySelector('[data-testid="proof-server-local-radio-checkmark"]'),
  remote: !!document.querySelector('[data-testid="proof-server-remote-radio-checkmark"]'),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
})).catch(() => ({}));
console.log('  proof server local :', setting.local);
console.log('  proof server remote:', setting.remote);
console.log('  panel text:', String(setting.text).slice(0, 260));
await ui.screenshot({ path: `${OUT}/dust-diagnose-settings.png`, fullPage: true }).catch(() => {});

// Lace proves Midnight transactions against a proof server it is pointed at,
// and on Remote its Send does nothing at all: no error, no dialog, the panel
// just sits there. That is the shape of the hang being chased here, so put it
// on Local, which is the proof server this repo runs on 6300.
if (!setting.local) {
  console.log('  switching to the local proof server');
  await tap('proof-server-local-radio', 'local proof server');
  for (const id of ['network-selection-sheet-confirm-button', 'confirm-button', 'save-button', 'next-btn']) {
    if (await tap(id, id)) break;
  }
  const after = await ui.evaluate(() => ({
    local: !!document.querySelector('[data-testid="proof-server-local-radio-checkmark"]'),
    remote: !!document.querySelector('[data-testid="proof-server-remote-radio-checkmark"]'),
  })).catch(() => ({}));
  console.log('  now local:', after.local, 'remote:', after.remote);
}

// 2. Run the flow with the worker recording.
//
// Reloading is how this gets back to the wallet: the settings panel sits over
// the account card, and clicking Generate tDUST underneath it times out.
console.log('\n2. generate tDUST');
await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(12000);
const pw2 = ui.locator('input[type="password"]:visible').first();
if (await pw2.count().catch(() => 0)) {
  await pw2.click().catch(() => {});
  await pw2.type(PASSWORD, { delay: 30 }).catch(() => {});
  await sleep(1500);
  const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
  if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
  else await ui.keyboard.press('Enter').catch(() => {});
  await sleep(10000);
}
await arm();
await dump('after settings');

if (!(await tap('account-card-generate-dust-button', 'Generate tDUST'))) {
  console.log('  no Generate tDUST control on this screen');
  const seen = await ui.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
    .map((e) => e.getAttribute('data-testid')))]).catch(() => []);
  console.log('  visible ids:', JSON.stringify(seen).slice(0, 700));
}

const btn = ui.locator('[data-testid="designate-button"]');
if (await btn.count().catch(() => 0)) {
  await btn.first().click({ timeout: 20000 }).then(() => console.log('  pressed Send'))
    .catch((e) => console.log('  Send failed: ' + e.message.split('\n')[0].slice(0, 90)));
}

for (let step = 1; step <= 8; step++) {
  await sleep(7000);
  const pwHere = ui.locator('input[type="password"]:visible').first();
  if (await pwHere.count().catch(() => 0)) {
    console.log(`  step ${step}: password`);
    await pwHere.click().catch(() => {});
    await pwHere.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
  }
  const shown = await ui.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const hit = t.match(/[^.]*(failed|error|insufficient|unable|timed out)[^.]*/i);
    return {
      proving: /zero-knowledge proof|Processing transaction/i.test(t),
      review: /Review Transaction/i.test(t),
      done: /All done|Success|submitted/i.test(t),
      error: hit ? hit[0].trim().slice(0, 160) : null,
    };
  }).catch(() => ({}));
  console.log(`  step ${step}:`, JSON.stringify(shown));
  await dump(`step ${step}`);
  if (shown.done) break;
  const next = ui.locator('[data-testid="designate-button"], [data-testid*="confirm"]').first();
  if (await next.count().catch(() => 0) && await next.isEnabled().catch(() => false)) {
    await next.click({ timeout: 15000 }).catch(() => {});
    continue;
  }
  const byText = ui.getByText(/^(Send|Confirm|Continue)$/).last();
  if (await byText.count().catch(() => 0)) await byText.click({ timeout: 15000 }).catch(() => {});
}

await ui.screenshot({ path: `${OUT}/dust-diagnose-end.png`, fullPage: true }).catch(() => {});
// Give the worker a last chance to report a rejection that landed late.
await sleep(20000);
await dump('final');
await ctx.close().catch(() => {});
process.exit(0);
