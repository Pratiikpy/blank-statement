// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The small controls, each one actually operated.
//
// The suites before this one prove the journeys. This is the rest: the byte
// counters that turn over at 32, the amount field's own opinion of what you
// typed, the copy-link button, the statements list and its Open button, and
// the wallet pill with no wallet installed. Individually small; together they
// are most of what a person touches.
//
// A control that "exists" is not tested. Each one here is driven until it
// changes something, and the change is read back.
//
//   node tests/controls.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/controls';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};

const state = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
if (!state) { console.log('BLOCKED: the bridge is not answering'); process.exit(2); }

const browser = await chromium.launch({ headless: true });
// A permission grant is needed for the clipboard, which is the only way to test
// the copy button honestly rather than just clicking it and believing the label.
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 160)); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }).catch(() => {});
const openTab = async (name) => {
  const t = page.getByRole('tab', { name });
  if (!(await t.count().catch(() => 0))) return false;
  await t.click().catch(() => {});
  await sleep(1200);
  return true;
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await sleep(1600);

// ===========================================================================
console.log('1. the byte counters');
// ===========================================================================
{
  await openTab('Asking');
  const readCounter = (helpId) => page.evaluate((h) => {
    const el = document.getElementById(h)?.querySelector('.counter');
    return el ? { text: el.textContent.trim(), over: el.className.includes('over') } : null;
  }, helpId);

  await page.locator('#who').fill('Northgate');
  await sleep(600);
  const short = await readCounter('who-help');
  check('C1', 'the name counter shows the bytes used', short?.text === '9/32 bytes', short?.text ?? '');
  check('C2', 'and is not flagged while it fits', short?.over === false);

  await page.locator('#who').fill('N'.repeat(33));
  await sleep(600);
  const over = await readCounter('who-help');
  check('C3', 'going past 32 bytes flags the counter', over?.over === true, over?.text ?? '');
  const invalid = await page.locator('#who').getAttribute('aria-invalid');
  check('C4', 'and the field marks itself invalid for a screen reader', invalid === 'true', String(invalid));
  const post = page.getByRole('button', { name: /Post the ask/i });
  check('C5', 'posting is blocked while it is too long',
    (await post.getAttribute('aria-disabled')) === 'true',
    String(await post.getAttribute('aria-disabled')));
  await shot('1-counter-over');

  // A multi-byte character has to count as its bytes, not its length, or the
  // chain refuses something the interface said was fine.
  await page.locator('#who').fill('é'.repeat(17));
  await sleep(600);
  const multi = await readCounter('who-help');
  check('C6', 'a two byte character counts as two bytes',
    multi?.text === '34/32 bytes' && multi?.over === true, multi?.text ?? '');

  await page.locator('#who').fill('Northgate Lettings');
  await sleep(500);
}

// ===========================================================================
console.log('\n2. the amount field');
// ===========================================================================
{
  const help = () => page.locator('#amt-help').innerText().catch(() => '');
  await page.locator('#amt').fill('nonsense');
  await sleep(700);
  check('C7', 'nonsense is called out', /not an amount/i.test(await help()), (await help()).slice(0, 60));
  const post = page.getByRole('button', { name: /Post the ask/i });
  check('C8', 'and posting is blocked', (await post.getAttribute('aria-disabled')) === 'true');

  await page.locator('#amt').fill('0');
  await sleep(700);
  check('C9', 'zero is refused with a reason',
    /more than nothing/i.test(await help()), (await help()).slice(0, 60));

  await page.locator('#amt').fill('99999999999999999999');
  await sleep(700);
  check('C10', 'an amount past the ledger field is refused',
    /larger than the ledger field/i.test(await help()), (await help()).slice(0, 70));

  // The field normalises on blur, which is the sort of thing that silently
  // changes what you meant if it is wrong.
  await page.locator('#amt').fill('1234.5');
  await page.locator('#who').click();
  await sleep(800);
  const normalised = await page.locator('#amt').inputValue();
  // No thousands separator on purpose. moneyInput is deliberately
  // locale-independent, because echoing the localised form back into the field
  // used to change the number: in de-DE it turned 20,450.99 into "20.450,99",
  // which parsed back as 20.45. Expecting "1,234.50" here was the test being
  // wrong about a decision the code documents.
  check('C11', 'a valid amount is tidied up on blur, not altered',
    normalised === '1234.50', normalised);
  check('C12', 'and the help text agrees with it',
    /£1,234\.50/.test(await help()), (await help()).slice(0, 70));
  await shot('2-amount');
}

// ===========================================================================
console.log('\n3. who may answer');
// ===========================================================================
{
  const options = await page.locator('#bind option').allInnerTexts();
  check('C13', 'the default is open to anyone',
    /Anyone holding the link/i.test(options[0] ?? ''), options[0] ?? '');
  check('C14', 'every holder can be named',
    options.length === (state.holders?.length ?? 0) + 1,
    `${options.length} options for ${state.holders?.length} holders`);
  console.log('  ' + options.join(' | '));
}

// ===========================================================================
console.log('\n4. the statements list');
// ===========================================================================
{
  await openTab('Statements');
  const rows = await page.locator('.rowlist .row').count();
  check('C15', 'the statements made are listed', rows > 0, `${rows} rows`);

  const firstRow = await page.locator('.rowlist .row').first().innerText().catch(() => '');
  console.log('  first row: ' + firstRow.replace(/\s+/g, ' ').slice(0, 90));
  // Same defect as the statement page had: a column of "Met the amount" says
  // nothing about which ask each one answered.
  check('C16', 'a listed statement names the amount it answered',
    /£[\d,]+\.\d{2}/.test(firstRow), firstRow.replace(/\s+/g, ' ').slice(0, 70));
  // The badge is upper-cased by the stylesheet, so match without regard to case.
  check('C17', 'and carries a yes or no badge', /\b(yes|no)\b/i.test(firstRow),
    firstRow.replace(/\s+/g, ' ').slice(0, 60));

  const open = page.getByRole('button', { name: /^Open statement/ }).first();
  check('C18', 'each row has a labelled Open button', await open.count() > 0);
  if (await open.count()) {
    await open.click();
    await sleep(1800);
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    check('C19', 'Open shows the statement card',
      /(Met|Did not meet) £/.test(text), text.slice(0, 80));
    check('C20', 'with the share link beside it', /#\/s\/[0-9a-f]+/.test(text),
      (text.match(/#\/s\/[0-9a-f]+/) ?? [''])[0]);
    await shot('4-statement-opened');
  }
}

// ===========================================================================
console.log('\n5. copy the link');
// ===========================================================================
{
  // Address the button by where it is, not by what it says.
  //
  // A locator built from the label stops matching the moment the label changes,
  // and Playwright re-resolves locators on every use, so reading it back after
  // the click found nothing and looked like the button had never responded. It
  // had: the label reads "Copied" from about 60ms and reverts around a second
  // later.
  const copy = page.locator('.sharebar button').first();
  if (await copy.count()) {
    const shown = await page.locator('.sharebar code').first().innerText().catch(() => '');
    check('C21a', 'the copy button rests as "Copy link"',
      /Copy link/i.test(await copy.innerText().catch(() => '')),
      await copy.innerText().catch(() => ''));
    await copy.click();
    await sleep(300);
    const label = await copy.innerText().catch(() => '');
    check('C21', 'the button says what happened', /Copied|Copy it by hand/i.test(label), label);
    // Read the clipboard back rather than trusting the label.
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (clip === null) {
      console.log('  the clipboard could not be read here; the label is the only evidence');
    } else {
      check('C22', 'the link really is on the clipboard', clip === shown, `${clip} vs ${shown}`);
    }
    // It must go back to its resting label, or the next copy looks like it did
    // not happen.
    await sleep(2600);
    check('C23', 'the button returns to its resting label',
      /Copy link/i.test(await copy.innerText().catch(() => '')),
      await copy.innerText().catch(() => ''));
    await shot('5-copied');
  } else {
    check('C21', 'there is a copy button on a statement', false, 'none found');
  }
}

// ===========================================================================
console.log('\n6. the wallet, with none installed');
// ===========================================================================
{
  const pill = await page.locator('.top').innerText().catch(() => '');
  check('C24', 'the header says there is no wallet', /No wallet/i.test(pill),
    pill.replace(/\s+/g, ' ').slice(0, 80));
  check('C25', 'and explains what that means in words',
    /No Midnight wallet in this browser/i.test(pill),
    pill.replace(/\s+/g, ' ').slice(0, 110));
  // It must not claim a connection it does not have.
  check('C26', 'it does not show an address', !/mn_addr|mn_shield/.test(pill));
  await shot('6-no-wallet');
}

// ===========================================================================
console.log('\n7. the network pill');
// ===========================================================================
{
  const net = await page.locator('.netpill').first().innerText().catch(() => '');
  check('C27', 'the network is named', /Local Midnight network/i.test(net), net);
  check('C28', 'and the contract it is talking to is shown',
    net.includes(state.address.slice(0, 10)), net);
}

check('C-err', 'no console errors while operating the controls', errors.length === 0,
  errors.slice(0, 3).join(' | '));

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
await context.close().catch(() => {});
await browser.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
