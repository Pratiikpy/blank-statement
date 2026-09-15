// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The record surface, used the way a person uses it.
//
// This is the tab a holder meets first and the one no test had ever driven:
// the textarea, the sample button, the file picker, the clear button, the live
// preview, and the anchor. It is also where the money comes from, so a quiet
// mistake here poisons every statement made afterwards.
//
// Everything is typed or clicked, the preview is recomputed independently
// rather than trusted, and the anchoring is checked against the ledger. The
// nasty inputs are the point: a thousands separator that is not quoted, a
// refund, a blank client, a file with a header and nothing else.
//
//   node tests/import-ui.mjs
//   VIEWPORT=mobile node tests/import-ui.mjs
import { chromium } from 'playwright';
import * as Midday from '@no-witness-labs/midday-sdk';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseCsv, toBatches, summarise, STATEMENT_CAPACITY } from '../app/import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/import';
const TMP = process.env.TMP_DIR ?? '/tmp/blank-import';
const VIEWPORT = process.env.VIEWPORT ?? 'desktop';
const SIZE = VIEWPORT === 'mobile' ? { width: 375, height: 812 } : { width: 1280, height: 800 };
// The chain comes from net.mjs so the whole suite moves together. A test that
// reads the local ledger while the bridge writes to preview is worse than no
// test: every assertion passes against the wrong chain.
const { NET, NETWORK, READER_SEED: NET_READER_SEED } = await import('./net.mjs');

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};

// ---------------------------------------------------------------- chain truth
const bridgeState = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
if (!bridgeState) { console.log('BLOCKED: the bridge is not answering on ' + BRIDGE); process.exit(2); }
const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
const readerWallet = await Midday.Wallet.fromSeed(NET_READER_SEED, NET);
const readerClient = await Midday.Client.create({
  wallet: readerWallet, networkConfig: NET,
  privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
});
const nope = () => { throw new Error('the reader must never run a circuit'); };
const readerLoaded = await readerClient.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'blank-statement-import-reader',
  witnesses: {
    holderSk: nope, batchAmounts: nope, batchCounterparties: nope,
    batchCount: nope, chain: nope, chainRands: nope, membership: nope,
  },
  initialPrivateState: {},
});
const readerDep = await readerLoaded.join(bridgeState.address, { initialPrivateState: {} });
const issued = async () => Number((await readerDep.ledgerState()).issued.toString());

// ------------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: SIZE });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
const shot = (label) =>
  page.screenshot({ path: `${OUT}/${VIEWPORT}-${label}.png`, fullPage: true }).catch(() => {});
const settled = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(900);
};

console.log(`import surface, ${VIEWPORT} ${SIZE.width}x${SIZE.height}\n`);
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await settled();
await page.getByRole('tab', { name: 'Your record' }).click();
await sleep(1200);

// The preview panel, read as a person reads it.
const previewOnScreen = () => page.evaluate(() => {
  // Scope everything to the import card, the one holding the textarea.
  //
  // Reading `.stat` from the whole document instead picks up the anchored
  // record card beside it and the statements card behind it, which all use the
  // same class. That made "clear removes the preview" fail against the record
  // card's own figures, which is a bug in the reading, not in the product.
  const card = document.querySelector('#csv')?.closest('.card') ?? document.body;
  const cardText = card.innerText;
  const stats = [...card.querySelectorAll('.stat')].map((s) => ({
    value: s.querySelector('span')?.textContent?.trim() ?? '',
    label: s.querySelector('small')?.textContent?.trim() ?? '',
  }));
  const anchor = [...card.querySelectorAll('button')]
    .find((b) => /^Anchor /.test(b.textContent.trim()));
  // The skipped rows render as a "N rows are left out" callout with one list
  // item per row, each naming the line and the reason. An earlier version of
  // this looked for the word "Skipped", which the product never says.
  const skippedItems = [...card.querySelectorAll('.rowlist .row')]
    .map((e) => e.innerText.replace(/\s+/g, ' ').trim());
  return {
    stats,
    note: (cardText.match(/\d+ batch(?:es)? of up to eight receipts[^.]*\./) ?? [])[0] ?? null,
    badFile: /That file cannot be read/i.test(cardText),
    badFileWhy: (cardText.match(/That file cannot be read\s*([^\n]*)/) ?? [])[1] ?? null,
    skippedCount: skippedItems.length,
    skippedText: skippedItems.join(' | '),
    leftOut: /left out/i.test(cardText),
    overflow: /One statement covers/i.test(cardText),
    overflowText: (cardText.match(/One statement covers[\s\S]{0,220}/i) ?? [])[0] ?? null,
    anchorLabel: anchor ? anchor.textContent.trim() : null,
    anchorDisabled: anchor ? anchor.getAttribute('aria-disabled') === 'true' : null,
    anchored: /\bAnchored\b/.test(cardText),
    importFailed: /Import failed/i.test(cardText),
  };
}).catch(() => ({}));

const typeCsv = async (text) => {
  const ta = page.locator('#csv');
  await ta.click();
  await ta.fill('');
  await sleep(200);
  // fill() for the bulk (typing thousands of characters takes minutes), then a
  // real keystroke so React's onChange fires the way it does for a person.
  await ta.fill(text);
  await ta.press('End');
  await sleep(900);
};

// ===========================================================================
console.log('A2. the sample button');
// ===========================================================================
await page.getByRole('button', { name: 'Use a sample' }).click();
await sleep(1200);
const sampleCsv = await page.locator('#csv').inputValue();
check('A2a', 'the sample fills the field', sampleCsv.length > 40, `${sampleCsv.length} chars`);
const sampleTruth = (() => {
  const { receipts, skipped } = parseCsv(sampleCsv);
  return { ...summarise(receipts, toBatches(receipts)), skipped };
})();
const sampleShown = await previewOnScreen();
check('A5a', 'the preview counts the receipts the parser finds',
  sampleShown.stats?.[0]?.value === String(sampleTruth.receipts),
  `screen ${sampleShown.stats?.[0]?.value} vs ${sampleTruth.receipts}`);
check('A5b', 'the preview counts the clients the parser finds',
  sampleShown.stats?.[1]?.value === String(sampleTruth.counterparties),
  `screen ${sampleShown.stats?.[1]?.value} vs ${sampleTruth.counterparties}`);
check('A5c', 'the preview total matches an independent recount',
  (sampleShown.stats?.[2]?.value ?? '').replace(/[^\d.]/g, '') ===
    (Number(sampleTruth.total) / 100).toFixed(2),
  `screen ${sampleShown.stats?.[2]?.value} vs ${(Number(sampleTruth.total) / 100).toFixed(2)}`);
check('A6a', 'the batch note matches the grouping',
  (sampleShown.note ?? '').startsWith(String(sampleTruth.batches) + ' batch'),
  sampleShown.note ?? 'no note');
check('A2b', 'the anchor button names what it will anchor',
  /^Anchor \d+ receipts?$/.test(sampleShown.anchorLabel ?? ''), sampleShown.anchorLabel);
await shot('a2-sample');

// ===========================================================================
console.log('\nA4. clear');
// ===========================================================================
await page.getByRole('button', { name: 'Clear' }).click();
await sleep(900);
check('A4a', 'clear empties the field', (await page.locator('#csv').inputValue()) === '');
const cleared = await previewOnScreen();
check('A4b', 'clear removes the import preview', (cleared.stats ?? []).length === 0,
  JSON.stringify(cleared.stats));
check('A12a', 'with nothing pasted there is nothing to anchor',
  cleared.anchorLabel === null, cleared.anchorLabel ?? '');
await shot('a4-cleared');

// ===========================================================================
console.log('\nA11/A10. inputs that should be refused or skipped');
// ===========================================================================
const cases = [
  {
    id: 'A11a',
    what: 'a header and no rows',
    csv: 'date,client,amount',
    expect: (s) => s.badFile === true,
    describe: (s) => s.badFileWhy ?? '',
  },
  {
    id: 'A11b',
    what: 'no amount column at all',
    csv: 'date,client\n2026-01-01,Acme Ltd',
    expect: (s) => s.badFile === true,
    describe: (s) => s.badFileWhy ?? '',
  },
  {
    id: 'A10a',
    what: 'an unquoted thousands separator',
    // 2,400.00 unquoted makes four cells against a three-cell header. Reading
    // it anyway would understate income, so it must be skipped and named.
    csv: 'date,client,amount\n2026-01-01,Acme Ltd,2,400.00\n2026-01-02,"Borden Studio","1,150.00"',
    expect: (s) => s.leftOut === true && /needs quoting|fields but the header/i.test(s.skippedText ?? ''),
    describe: (s) => (s.skippedText ?? '').slice(0, 120),
  },
  {
    id: 'A10b',
    what: 'a refund (negative amount)',
    csv: 'date,client,amount\n2026-01-01,Acme Ltd,-500.00\n2026-01-02,"Borden Studio","1,150.00"',
    expect: (s) => s.leftOut === true && /not a payment received/i.test(s.skippedText ?? ''),
    describe: (s) => (s.skippedText ?? '').slice(0, 120),
  },
  {
    id: 'A10c',
    what: 'a row with no client',
    csv: 'date,client,amount\n2026-01-01,,500.00\n2026-01-02,"Borden Studio","1,150.00"',
    expect: (s) => s.leftOut === true && /no counterparty/i.test(s.skippedText ?? ''),
    describe: (s) => (s.skippedText ?? '').slice(0, 120),
  },
  {
    id: 'A10d',
    what: 'an amount that is not a number',
    csv: 'date,client,amount\n2026-01-01,Acme Ltd,about a grand\n2026-01-02,"Borden Studio","1,150.00"',
    expect: (s) => s.leftOut === true && s.skippedCount > 0,
    describe: (s) => (s.skippedText ?? '').slice(0, 120),
  },
  {
    id: 'A10e',
    what: 'a quote that never closes',
    csv: 'date,client,amount\n2026-01-01,"Acme Ltd,500.00\n2026-01-02,"Borden Studio","1,150.00"',
    expect: (s) => (s.leftOut === true && s.skippedCount > 0) || s.badFile === true,
    describe: (s) => ((s.skippedText ?? '') + (s.badFileWhy ?? '')).slice(0, 120),
  },
];

for (const c of cases) {
  await typeCsv(c.csv);
  const shown = await previewOnScreen();
  check(c.id, c.what + ' is handled honestly', c.expect(shown), c.describe(shown));
}
await shot('a10-skipped');

// A rejected file must not be anchorable at all.
await typeCsv('date,client,amount');
const headerOnly = await previewOnScreen();
check('A12b', 'a file that cannot be read offers no anchor button',
  headerOnly.anchorLabel === null, headerOnly.anchorLabel ?? '');

// ===========================================================================
console.log('\nA9. more receipts than one statement can cover');
// ===========================================================================
{
  const rows = ['date,client,amount'];
  const many = STATEMENT_CAPACITY + 12;
  for (let i = 0; i < many; i++) {
    rows.push(`2026-01-${String((i % 28) + 1).padStart(2, '0')},"Client ${i}","10.00"`);
  }
  await typeCsv(rows.join('\n'));
  const shown = await previewOnScreen();
  check('A9a', 'it warns that one statement cannot cover them all', shown.overflow === true,
    (shown.overflowText ?? '').replace(/\s+/g, ' ').slice(0, 130));
  check('A9b', 'the warning names the capacity',
    (shown.overflowText ?? '').includes(String(STATEMENT_CAPACITY)),
    String(STATEMENT_CAPACITY));
  check('A9c', 'the anchor button offers only what can be proven',
    shown.anchorLabel === `Anchor ${STATEMENT_CAPACITY} receipts`, shown.anchorLabel ?? '');
  await shot('a9-overflow');
}

// ===========================================================================
console.log('\nA3. choosing a real file');
// ===========================================================================
{
  const csv = [
    'date,client,amount',
    '2026-02-01,"Halden & Co","1,200.00"',
    '2026-02-08,"Irwell Design","450.50"',
    '2026-02-15,"Jarrow Media","2,000.00"',
  ].join('\n');
  const file = join(TMP, 'payments.csv');
  writeFileSync(file, csv);
  await page.getByRole('button', { name: 'Clear' }).click().catch(() => {});
  await sleep(600);
  await page.locator('input[type="file"]').setInputFiles(file);
  await sleep(1500);
  const loaded = await page.locator('#csv').inputValue();
  check('A3a', 'the file contents land in the field', loaded.trim() === csv.trim(),
    `${loaded.length} chars`);
  const shown = await previewOnScreen();
  const truth = (() => {
    const { receipts } = parseCsv(csv);
    return summarise(receipts, toBatches(receipts));
  })();
  check('A3b', 'the preview for a file matches the parser',
    shown.stats?.[0]?.value === String(truth.receipts), shown.stats?.[0]?.value ?? '');
  await shot('a3-file');
}

// ===========================================================================
console.log('\nA7/A8. anchoring for real');
// ===========================================================================
{
  const csv = [
    'date,client,amount',
    '2026-03-01,"Kelvin Works","900.00"',
    '2026-03-05,"Lomond Ltd","1,100.00"',
    '2026-03-09,"Mersey Group","750.25"',
    '2026-03-14,"Nene Partners","1,480.00"',
  ].join('\n');
  await typeCsv(csv);
  const before = await issued();
  const shown = await previewOnScreen();
  console.log(`  anchoring ${shown.anchorLabel}, issued is ${before}`);
  await shot('a7-before');

  await page.getByRole('button', { name: /^Anchor / }).click();
  // Anchoring is one transaction per entry and takes minutes.
  let done = false;
  for (let i = 0; i < 90; i++) {
    await sleep(4000);
    const s = await previewOnScreen();
    if (s.anchored || s.importFailed) { done = true; break; }
  }
  const after = await previewOnScreen();
  await shot('a7-after');
  check('A7a', 'the import finished', done, done ? '' : 'it never resolved');
  check('A7b', 'it reports success rather than failure', after.anchored === true && !after.importFailed,
    after.importFailed ? 'import failed' : '');

  const nowIssued = await issued();
  check('A7c', 'the ledger counter rose', nowIssued > before, `${before} -> ${nowIssued}`);
  // Padding is the privacy claim: the number of entries must not depend on how
  // much history there was.
  const entries = nowIssued - before;
  check('A8a', 'the entries written are a fixed run, not one per receipt',
    entries === STATEMENT_CAPACITY / 8, `${entries} entries for 4 receipts`);
  console.log(`  ${entries} entries on chain for 4 receipts (padding hides the length)`);
}

check('E-err', 'no console errors anywhere on this surface', errors.length === 0,
  errors.slice(0, 3).join(' | '));

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed  (${VIEWPORT})`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
console.log(`\nscreenshots in ${OUT}`);
await context.close().catch(() => {});
await browser.close().catch(() => {});
await readerWallet.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
