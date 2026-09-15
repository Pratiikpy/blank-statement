// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Lace's own "Generate tDUST", on preview, with the configuration it needs.
//
// This has been tried before and never under the right conditions. The first
// attempts ran with the proof server setting silently unsaved, so the wallet
// proved against a server nobody had chosen. Later attempts ran on the local
// chain. What has never been done is the obvious thing: put the wallet on
// preview, point it at preview's own proof server, save that, and press the
// button.
//
// It matters because the wallet is the only path left. The NIGHT on preview is
// unregistered, so it generates no DUST; registering it from Node needs a fee
// it does not have; and midday says plainly that DUST registration is not in
// the DApp connector at all, pointing at the Lace UI instead. This is that UI.
//
// The run does not change any setting. It reads what the wallet is configured
// for and refuses to continue if that is wrong, because a run under the wrong
// configuration is what produced two false conclusions already.
//
//   node tests/preview-dust.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/preview-dust';
const PASSWORD = LACE_PASSWORD;
const NETWORK = process.env.NETWORK ?? 'preview';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
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

// Watch what the wallet asks for. Proving on preview should reach preview's
// proof server, and a request to localhost here would be the misconfiguration
// this run exists to avoid.
const traffic = [];
const interesting = (u) => /midnight\.network|:6300|:9944|proof|graphql/.test(u);
ctx.on('request', (r) => { if (interesting(r.url())) traffic.push('-> ' + r.method() + ' ' + r.url().slice(0, 90)); });
ctx.on('response', (r) => { if (interesting(r.url())) traffic.push('<- ' + r.status() + ' ' + r.url().slice(0, 90)); });
ctx.on('requestfailed', (r) => { if (interesting(r.url())) traffic.push('!! ' + r.url().slice(0, 90) + ' ' + (r.failure()?.errorText ?? '')); });

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
const open = async () => {
  await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(14000);
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    await pw.click().catch(() => {});
    await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(12000);
  }
};
const tap = async (id, what = id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`  no ${what}`); return false; }
  await el.click({ timeout: 20000 }).then(() => console.log('  tap', what))
    .catch((e) => console.log(`  ${what}: ` + e.message.split('\n')[0].slice(0, 70)));
  await sleep(4500);
  return true;
};

await open();

// ---------------------------------------------------------------------------
console.log('1. is the wallet configured the way this needs?');
// ---------------------------------------------------------------------------
await tap('settings-tab-btn', 'Settings');
await tap('option-list-item-midnight', 'Midnight');
const cfg = await ui.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ');
  return {
    local: !!document.querySelector('[data-testid="proof-server-local-radio-checkmark"]'),
    remote: !!document.querySelector('[data-testid="proof-server-remote-radio-checkmark"]'),
    node: (t.match(/Node address (\S+)/) ?? [])[1] ?? null,
    indexer: (t.match(/Indexer address (\S+)/) ?? [])[1] ?? null,
  };
}).catch(() => ({}));
console.log('  proof server :', cfg.remote ? 'Remote' : cfg.local ? 'Local' : 'unknown');
console.log('  node         :', cfg.node);
console.log('  indexer      :', cfg.indexer);
check(`the wallet is on ${NETWORK}`, String(cfg.node ?? '').includes(NETWORK), cfg.node ?? '');
check('and proves against that network, not this laptop', cfg.remote === true,
  cfg.local ? 'still set to Local' : 'unknown');
await ui.screenshot({ path: `${OUT}/1-config.png`, fullPage: true }).catch(() => {});
if (failures) {
  console.log('\nrefusing to run under the wrong configuration.');
  console.log('set it with:  NETWORK=preview node tests/lace-network-set.mjs');
  console.log('              PROOF=remote TARGET=preview node tests/lace-point-local.mjs');
  await ctx.close().catch(() => {});
  process.exit(2);
}

// ---------------------------------------------------------------------------
console.log('\n2. what the wallet holds before');
// ---------------------------------------------------------------------------
await open();
const holdings = () => ui.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ');
  return {
    night: (t.match(/tNIGHT ([\d,.]+)/) ?? [])[1] ?? null,
    dust: (t.match(/([\d,./ ]+)tDUST/) ?? [])[1]?.trim() ?? null,
    tank: /tDUST Tank (\w+)/.exec(t)?.[1] ?? null,
  };
}).catch(() => ({}));
const before = await holdings();
console.log('  ', JSON.stringify(before));
await ui.screenshot({ path: `${OUT}/2-before.png`, fullPage: true }).catch(() => {});

// ---------------------------------------------------------------------------
console.log('\n3. pressing Generate tDUST');
// ---------------------------------------------------------------------------
traffic.length = 0;
if (!(await tap('account-card-generate-dust-button', 'Generate tDUST'))) {
  console.log('  there is no Generate tDUST control on this screen');
  await ctx.close().catch(() => {});
  process.exit(3);
}
await ui.screenshot({ path: `${OUT}/3-panel.png`, fullPage: true }).catch(() => {});

// The panel arrives filled in; it needs its own Send, then a second Send on the
// review step, and the password in between.
const btn = ui.locator('[data-testid="designate-button"]');
if (await btn.count().catch(() => 0)) {
  await btn.first().click({ timeout: 25000 }).then(() => console.log('  pressed Send'))
    .catch((e) => console.log('  Send: ' + e.message.split('\n')[0].slice(0, 70)));
}

let done = false;
for (let step = 1; step <= 14; step++) {
  await sleep(8000);
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    await pw.click().catch(() => {});
    await pw.fill('').catch(() => {});
    await pw.type(PASSWORD, { delay: 25 }).catch(() => {});
    await sleep(1500);
  }
  const shown = await ui.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const hit = t.match(/[^.]*(failed|error|insufficient|unable|timed out|rejected)[^.]*/i);
    return {
      proving: /zero-knowledge proof|Processing transaction/i.test(t),
      review: /Review Transaction/i.test(t),
      done: /All done|Success|submitted/i.test(t),
      error: hit ? hit[0].trim().slice(0, 150) : null,
    };
  }).catch(() => ({}));
  console.log(`  step ${step}:`, JSON.stringify(shown));
  if (shown.error) console.log('    ON SCREEN:', shown.error);
  if (shown.done) { done = true; break; }
  const next = ui.locator('[data-testid="designate-button"], [data-testid*="confirm"]').first();
  if (await next.count().catch(() => 0) && await next.isEnabled().catch(() => false)) {
    await next.click({ timeout: 20000 }).catch(() => {});
    continue;
  }
  const byText = ui.getByText(/^(Send|Confirm|Continue)$/).last();
  if (await byText.count().catch(() => 0)) await byText.click({ timeout: 20000 }).catch(() => {});
}
await ui.screenshot({ path: `${OUT}/4-after.png`, fullPage: true }).catch(() => {});

console.log('\n4. what the wallet asked for while doing it');
const seen = [...new Set(traffic)];
for (const t of seen.slice(0, 25)) console.log('   ' + t);
const provedRemotely = seen.some((t) => /proof-server\..*midnight\.network/.test(t));
const provedLocally = seen.some((t) => /:6300/.test(t));
check('it proved against the network, not this laptop',
  provedRemotely || !provedLocally, provedLocally ? 'it called localhost:6300' : 'no proof call seen');

// ---------------------------------------------------------------------------
console.log('\n5. did any DUST actually appear?');
// ---------------------------------------------------------------------------
let after = before;
for (let i = 0; i < 10; i++) {
  await sleep(15000);
  await open();
  after = await holdings();
  console.log(`  +${(i + 1) * 15}s`, JSON.stringify(after));
  // Judge it on the DUST figure, not on the "Tank Empty" label. That label is
  // removed the moment the tank stops being empty, so waiting for it to change
  // text means waiting for something that no longer exists, and reporting a
  // failure on a run that worked.
  const now = Number(String(after.dust ?? '0').split('/')[0].replace(/[^\d]/g, '') || 0);
  if (now > 0) break;
}
await ui.screenshot({ path: `${OUT}/5-final.png`, fullPage: true }).catch(() => {});

const dustNow = Number(String(after.dust ?? '0').split('/')[0].replace(/[^\d]/g, '') || 0);
check('the wallet now holds DUST', dustNow > 0, `dust ${after.dust}`);
console.log(`\n  before: ${JSON.stringify(before)}`);
console.log(`  after : ${JSON.stringify(after)}`);

console.log(`\n${failures === 0 ? 'preview can now pay its own fees' : failures + ' check(s) failed'}`);
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
