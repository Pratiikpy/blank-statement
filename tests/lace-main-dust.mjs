// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Register the wallet's tNIGHT for DUST generation, in the main Lace extension.
//
// Holding NIGHT generates nothing on its own. The registration transaction is
// what starts DUST accruing, and without DUST the wallet cannot pay a fee, so
// it cannot sign anything at all. Lace labels this "Generate tDUST" and shows
// the result as the tNIGHT designation.
//
// The control is on the account card: account-card-generate-dust-button. It
// opens Lace's ordinary send form, pre-addressed to the wallet's own dust
// address, which needs an amount before the review button does anything.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
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
const extId = sw ? new URL(sw.url()).host : 'gafhhkghbfjjkeiendhlofajokpaflmk';
await ext.close().catch(() => {});

// Watch at the CONTEXT level, not just the page: the wallet submits from its
// service worker, so page-level listeners see nothing and a failed submission
// looks like silence.
const traffic = [];
const interesting = (u) => /midnight\.network|:6300|:9944|rpc\.|indexer\.|proof/.test(u);
ctx.on('request', (r) => { if (interesting(r.url())) traffic.push('-> ' + r.method() + ' ' + r.url().slice(0, 95)); });
ctx.on('response', (r) => { if (interesting(r.url())) traffic.push('<- ' + r.status() + ' ' + r.url().slice(0, 95)); });
ctx.on('requestfailed', (r) => { if (interesting(r.url())) traffic.push('!! ' + r.url().slice(0, 95) + ' ' + (r.failure()?.errorText ?? '')); });

const ui = await ctx.newPage();
// The wallet's own console is the only place a silent Send failure shows up.
const walletLog = [];
ui.on('console', (m) => { if (['error', 'warning'].includes(m.type())) walletLog.push(m.type() + ': ' + m.text().slice(0, 220)); });
ui.on('pageerror', (e) => walletLog.push('pageerror: ' + String(e).slice(0, 220)));
const netFail = [];
ui.on('requestfailed', (r) => netFail.push(r.url().slice(0, 90) + ' ' + (r.failure()?.errorText ?? '')));
ui.on('response', (r) => { if (r.status() >= 400) netFail.push(r.status() + ' ' + r.url().slice(0, 90)); });
await ui.setViewportSize({ width: 1280, height: 1100 });
for (let i = 1; i <= 5; i++) {
  const r = await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (r) break;
  await sleep(4000);
}
await sleep(12000);

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
  await sleep(9000);
  return true;
};
await unlock();

const state = () => ui.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ');
  return {
    night: (t.match(/tNIGHT ([\d,.]+)/) ?? [])[1] ?? null,
    dust: (t.match(/([\d,./ ]+)tDUST/) ?? [])[1]?.trim() ?? null,
    text: t.slice(0, 220),
  };
}).catch(() => ({}));
const ids = () => ui.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')]
  .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
  .map((e) => e.getAttribute('data-testid')))]).catch(() => []);
const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`  no ${what}`); return false; }
  console.log('  tap', what);
  await el.click().catch((e) => console.log('    threw:', e.message.slice(0, 45)));
  await sleep(4500);
  return true;
};

console.log('before:', JSON.stringify(await state()));
await ui.screenshot({ path: `${OUT}/main-dust-before.png`, fullPage: true }).catch(() => {});

if (!(await tap('account-card-generate-dust-button', 'Generate tDUST'))) {
  console.log('no Generate tDUST control; is there any tNIGHT?');
  await ctx.close().catch(() => {});
  process.exit(2);
}
console.log('\nform:', JSON.stringify(await state()));
const formIds = await ids();
console.log('ids on the form:', JSON.stringify(formIds));
// Every clickable-looking thing in the panel, with its box, so the real Send
// can be named rather than guessed at by position.
const clickables = await ui.evaluate(() => {
  const w = window.innerWidth;
  return [...document.querySelectorAll('*')]
    .filter((el) => {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return t && t.length < 26 && r.width > 60 && r.height > 18 && r.left > w * 0.45;
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), t: el.getAttribute('data-testid'),
               label: (el.innerText || '').trim().slice(0, 24),
               box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    })
    .slice(0, 25);
}).catch(() => []);
console.log('panel controls:');
for (const c of clickables) console.log('   ' + JSON.stringify(c));
await ui.screenshot({ path: `${OUT}/main-dust-form.png`, fullPage: true }).catch(() => {});

// The form arrives complete: the dust address is filled in, the tNIGHT is
// already selected, and the fee is zero. There is nothing to type — it just
// needs its own Send pressed.
//
// The catch is that the account card behind the panel has a Send button too,
// and a plain has-text("Send") finds that one first, which does nothing here.
// Pick the Send inside the panel by position.
// The panel's Send has a name: designate-button. Guessing by position picked
// its wrapper div instead, which swallows the click. Playwright's own click
// does the actionability checks and says why if it cannot.
const btn = ui.locator('[data-testid="designate-button"]');
const found = await btn.count().catch(() => 0);
console.log('\ndesignate-button found:', found);
let sent = false;
if (found) {
  console.log('  enabled:', await btn.first().isEnabled().catch(() => 'unknown'));
  console.log('  visible:', await btn.first().isVisible().catch(() => 'unknown'));
  await btn.first().click({ timeout: 20000 })
    .then(() => { sent = true; })
    .catch((e) => console.log('  click failed:', e.message.split('\n')[0].slice(0, 120)));
}
console.log('pressed Send:', sent);

// Two steps, both labelled Send: the first opens Review Transaction, the second
// submits it. Keep pressing whatever primary action the panel currently shows,
// answering the password prompt when it appears, until the panel is done.
for (let step = 1; step <= 6; step++) {
  await sleep(6000);

  const pwHere = ui.locator('input[type="password"]:visible').first();
  if (await pwHere.count().catch(() => 0)) {
    console.log(`  step ${step}: password`);
    await pwHere.click().catch(() => {});
    await pwHere.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
  }

  const shown = await ui.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    return {
      review: /Review Transaction/i.test(t),
      done: /All done|Success|submitted/i.test(t),
      error: (t.match(/[^.]*(failed|error|insufficient|unable)[^.]*/i) ?? [])[0]?.trim()?.slice(0, 140) ?? null,
    };
  }).catch(() => ({}));
  console.log(`  step ${step}:`, JSON.stringify(shown));
  if (shown.error) console.log('    ERROR ON SCREEN:', shown.error);
  if (shown.done) { console.log('  submitted'); break; }

  // The primary action, whatever it is called on this step.
  const next = ui.locator('[data-testid="designate-button"], [data-testid*="confirm"]').first();
  if (await next.count().catch(() => 0) && await next.isEnabled().catch(() => false)) {
    await next.click({ timeout: 15000 }).catch((e) => console.log('    click:', e.message.split('\n')[0].slice(0, 80)));
    continue;
  }
  const byText = ui.getByText(/^(Send|Confirm|Continue)$/).last();
  if (await byText.count().catch(() => 0)) {
    await byText.click({ timeout: 15000 }).catch((e) => console.log('    click:', e.message.split('\n')[0].slice(0, 80)));
  } else {
    console.log('  nothing further to press');
    break;
  }
}
await ui.screenshot({ path: `${OUT}/main-dust-submitted.png`, fullPage: true }).catch(() => {});

await unlock();
await sleep(6000);
console.log('  now:', (await state()).text?.slice(-200));

// Whatever confirmation follows.
for (const label of ['Confirm', 'Continue', 'Done', 'Close']) {
  const b = ui.locator(`button:has-text("${label}"):visible`).first();
  if (await b.count().catch(() => 0) && await b.isEnabled().catch(() => false)) {
    console.log('  pressing', label);
    await b.click().catch(() => {});
    await sleep(7000);
    await unlock();
  }
}

await ui.screenshot({ path: `${OUT}/main-dust-after.png`, fullPage: true }).catch(() => {});
console.log('\nafter:', JSON.stringify(await state()));

// DUST accrues per block once designated.
for (const wait of [20000, 30000, 45000]) {
  await sleep(wait);
  const s = await state();
  console.log(`  +${Math.round(wait / 1000)}s`, JSON.stringify(s));
  if (s.dust && !/^0 \/ 0/.test(s.dust)) { console.log('\nthe tank is filling'); break; }
}
await ui.screenshot({ path: `${OUT}/main-dust-final.png`, fullPage: true }).catch(() => {});

console.log('\nwhat the wallet talked to:');
for (const t of [...new Set(traffic)].slice(0, 30)) console.log('   ' + t);
if (!traffic.length) console.log('   (nothing)');

console.log('\nwallet console (errors and warnings):');
for (const l of [...new Set(walletLog)].slice(0, 15)) console.log('   ' + l);
if (!walletLog.length) console.log('   (nothing)');
console.log('\nrequests that failed:');
for (const l of [...new Set(netFail)].slice(0, 15)) console.log('   ' + l);
if (!netFail.length) console.log('   (none)');

await ctx.close().catch(() => {});
process.exit(0);
