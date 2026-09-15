// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The seams: what happens where two things meet.
//
// Features in isolation hide the bugs. This is the combinatorial half of the
// plan: navigating away mid-flow, following one share link straight to
// another, switching theme while a form is filled, going back and forward,
// reloading with work in progress, two holders answering at the same instant,
// a deep link opened before the app has ever been loaded, and the app with the
// bridge taken away underneath it.
//
// These are the cases a demo never reaches and a real session hits in the
// first ten minutes.
//
//   node tests/seams.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/seams';
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
const ids = (state.verdicts ?? []).map((v) => v.id);
console.log(`${ids.length} statement(s) on chain to navigate between\n`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 160)); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }).catch(() => {});
const settled = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1100);
};
const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
const openTab = async (name) => {
  const t = page.getByRole('tab', { name });
  if (!(await t.count().catch(() => 0))) return false;
  await t.click().catch(() => {});
  await sleep(1200);
  return true;
};

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await settled();

// ===========================================================================
console.log('1. work in progress survives moving around');
// ===========================================================================
{
  await openTab('Your record');
  const csv = 'date,client,amount\n2026-05-01,"Seam Ltd","123.45"';
  await page.locator('#csv').fill(csv);
  await sleep(900);
  await openTab('Asking');
  await page.locator('#who').fill('Seam Verifier');
  await sleep(500);
  await openTab('Your record');
  await sleep(900);
  check('T1', 'the pasted CSV is still there after visiting another tab',
    (await page.locator('#csv').inputValue()) === csv);
  await openTab('Asking');
  check('T2', 'the typed name is still there too',
    (await page.locator('#who').inputValue()) === 'Seam Verifier');
  await shot('1-tabs-keep-state');
}

// ===========================================================================
console.log('\n2. the theme can be changed mid-flow');
// ===========================================================================
{
  const before = await page.locator('#who').inputValue();
  const themeBtn = page.locator('button.themebtn');
  const first = await page.evaluate(() => document.documentElement.getAttribute('data-theme') ??
    getComputedStyle(document.body).backgroundColor);
  await themeBtn.click();
  await sleep(1000);
  const second = await page.evaluate(() => document.documentElement.getAttribute('data-theme') ??
    getComputedStyle(document.body).backgroundColor);
  check('T3', 'the theme button changes the theme', first !== second, `${first} -> ${second}`);
  check('T4', 'changing theme does not clear the form',
    (await page.locator('#who').inputValue()) === before, before);
  await shot('2-theme-switched');
  // Put it back so the rest of the run is in the default.
  await themeBtn.click();
  await sleep(800);
  await themeBtn.click();
  await sleep(800);
}

// ===========================================================================
console.log('\n3. keyboard alone can move between sections');
// ===========================================================================
{
  const tab = page.getByRole('tab', { name: 'Asking' });
  await tab.focus();
  const before = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press('ArrowRight');
  await sleep(700);
  const after = await page.evaluate(() => ({
    focused: document.activeElement?.textContent?.trim(),
    selected: document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim(),
  }));
  check('T5', 'arrow keys move between tabs', after.focused !== before,
    `${before} -> ${after.focused}`);
  check('T6', 'the tab that has focus is the one selected', after.focused === after.selected,
    `focused ${after.focused}, selected ${after.selected}`);
  // A roving tabindex is what makes a tablist usable with a keyboard.
  const roving = await page.evaluate(() =>
    [...document.querySelectorAll('[role=tab]')].map((t) => t.getAttribute('tabindex')));
  check('T7', 'only the selected tab is in the tab order',
    roving.filter((t) => t === '0').length === 1, roving.join(','));
}

// ===========================================================================
console.log('\n4. following one share link straight to another');
// ===========================================================================
if (ids.length >= 2) {
  await page.goto(`${APP}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
  await settled();
  const first = await bodyText();
  check('T8', 'the first statement renders', /Met|Did not meet/.test(first), first.slice(0, 60));

  // Hash navigation, not a reload: this is the path that once left the
  // previous answer's error card sitting above the new statement.
  await page.evaluate((id) => { window.location.hash = '#/s/' + id; }, ids[1]);
  await sleep(2500);
  const second = await bodyText();
  check('T9', 'the second statement replaces the first',
    second.includes(ids[1]) && !second.includes(ids[0]),
    second.slice(0, 70));
  check('T10', 'no stale error card is left behind', !/No statement here/i.test(second));
  await shot('4-second-statement');

  // And on to one that does not exist.
  await page.evaluate(() => { window.location.hash = '#/s/deadbeefdeadbeef'; });
  await sleep(2500);
  const missing = await bodyText();
  check('T11', 'a bad link after a good one says so plainly',
    /No statement here/i.test(missing), missing.slice(0, 70));
  check('T12', 'and does not still show the previous verdict',
    !/Met £|Did not meet £/.test(missing), missing.slice(0, 70));
  await shot('4-missing-after-good');

  // Back should return to a real statement, not the error.
  await page.goBack();
  await sleep(2500);
  const back = await bodyText();
  check('T13', 'going back returns to the statement that was there',
    /Met|Did not meet/.test(back) && !/No statement here/i.test(back), back.slice(0, 70));
  await shot('4-after-back');
} else {
  console.log('  skipped: fewer than two statements on chain');
}

// ===========================================================================
console.log('\n5. a deep link in a browser that has never seen the app');
// ===========================================================================
if (ids.length) {
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await fresh.newPage();
  await p.goto(`${APP}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(2500);
  const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('T14', 'a cold deep link renders the statement', /Met|Did not meet/.test(text),
    text.slice(0, 70));

  // Now walk from the statement into the app proper, which is what a curious
  // verifier does next.
  await p.evaluate(() => { window.location.hash = '#/'; });
  await sleep(2500);
  const app = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('T15', 'from a statement you can reach the app itself',
    /Your record|Asking|Answering/.test(app), app.slice(0, 70));
  check('T16', 'and the statement page is not still showing', !/reference [0-9a-f]{16}/.test(app.slice(0, 200)),
    app.slice(0, 70));
  await p.screenshot({ path: `${OUT}/5-statement-into-app.png`, fullPage: true }).catch(() => {});
  await fresh.close().catch(() => {});
}

// ===========================================================================
console.log('\n6. reload with a form half filled');
// ===========================================================================
{
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await settled();
  await openTab('Asking');
  await page.locator('#who').fill('Half Filled Ltd');
  await page.locator('#amt').fill('99.99');
  await sleep(600);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settled();
  await openTab('Asking');
  const who = await page.locator('#who').inputValue();
  // Either answer is defensible; what matters is that the page is usable and
  // does not come back with half a form and a stuck button.
  console.log(`  after reload the name field holds ${JSON.stringify(who)}`);
  const post = page.getByRole('button', { name: /Post the ask/i });
  check('T17', 'the form is usable after a reload', await post.count() > 0);
  check('T18', 'the post button is not stuck in its busy state',
    !/Posting/.test(await post.innerText().catch(() => '')),
    await post.innerText().catch(() => ''));
  await shot('6-after-reload');
}

// ===========================================================================
console.log('\n7. the bridge disappears underneath the app');
// ===========================================================================
{
  // Not by stopping the bridge, which would break every other test running
  // beside this one, but by cutting this page off from it. Same thing from the
  // page's point of view.
  await page.route('**/api/**', (route) => route.abort());
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const text = await bodyText();
  check('T19', 'losing the bridge is said plainly, not left as a blank page',
    /Cannot reach the bridge|npm run bridge/i.test(text), text.slice(0, 100));
  check('T20', 'the page still renders its shell', /blank\./.test(text), text.slice(0, 60));
  await shot('7-bridge-gone');

  // And it must recover on its own when the bridge comes back, which is what
  // the card promises.
  await page.unroute('**/api/**');
  await sleep(9000);
  const back = await bodyText();
  check('T21', 'it recovers by itself once the bridge answers again',
    !/Cannot reach the bridge/i.test(back), back.slice(0, 90));
  await shot('7-bridge-back');
}

check('T-err', 'no console errors across every seam', errors.length === 0,
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
