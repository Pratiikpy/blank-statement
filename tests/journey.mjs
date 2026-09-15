// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The core journey, driven through the interface the way a person drives it:
// post an ask, answer it as a holder, then read the statement that comes out and
// follow its share link as a stranger would.
//
// Every other suite here either renders the app or talks to the bridge directly.
// This one is the only thing that proves the two halves are still connected, so
// it is what catches a refactor that renders perfectly and does nothing. It
// writes to a real chain, so it takes minutes, not seconds.
import { chromium } from 'playwright';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
// Unique per run: the contract refuses a reference that has already been used,
// and a fixed one would pass once and then fail forever.
const REF = 'journey-' + Math.random().toString(36).slice(2, 9);
const AMOUNT = '250.00';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)));

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tab', { timeout: 30000 });

// --- post an ask ------------------------------------------------------------
console.log('\n1. posting an ask');
await page.getByRole('tab', { name: 'Asking' }).click();
await page.waitForSelector('#who', { timeout: 15000 });
await page.fill('#who', 'Northgate Lettings');
await page.fill('#amt', AMOUNT);
await page.fill('#ref', REF);
await page.selectOption('#bind', 'alice').catch(() => {});
console.log(`  reference ${REF}, at least £${AMOUNT}, bound to Alice`);

await page.getByRole('button', { name: /Post the ask/i }).click();
// Anchoring is a real transaction: proof, balance, submit, block.
await page.waitForFunction(
  (ref) => [...document.querySelectorAll('*')].some((el) => el.childElementCount === 0 && el.textContent?.trim() === ref),
  REF, { timeout: 240000 },
).catch(() => {});
const asked = await page.evaluate((ref) => document.body.innerText.includes(ref), REF);
check('the ask appears in Open asks', asked, REF);
await page.screenshot({ path: `${OUT}/journey-1-asked.png` });

// --- answer it --------------------------------------------------------------
console.log('\n2. answering it as Alice');
await page.getByRole('tab', { name: 'Answering' }).click();
await page.waitForSelector('#as', { timeout: 15000 });
await page.selectOption('#as', 'alice');
await page.waitForFunction(
  (ref) => [...document.querySelectorAll('#ask option')].some((o) => o.value === ref),
  REF, { timeout: 30000 },
).catch(() => {});
await page.selectOption('#ask', REF).catch((e) => console.log('  could not select:', e.message.slice(0, 70)));

const willPublish = await page.evaluate(() => document.querySelector('.callout')?.innerText ?? '');
check('it says what will be published before anything is sent',
  /Whether you cleared/i.test(willPublish), JSON.stringify(willPublish.slice(0, 60)));

await page.getByRole('button', { name: /Answer it/i }).click();
await page.waitForFunction(
  () => !document.querySelector('button[aria-busy="true"]'),
  null, { timeout: 300000 },
).catch(() => {});
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/journey-2-answered.png` });

const refused = await page.evaluate(() => document.querySelector('.callout.bad')?.innerText ?? null);
check('the chain did not refuse it', !refused, refused ? JSON.stringify(refused.slice(0, 90)) : '');

// --- read the statement -----------------------------------------------------
// A statement is not filed under the ask's reference. It gets its own id, and
// the share link is built from that, so the reference is the wrong thing to
// look for here. Take the link the app itself produced.
console.log('\n3. reading the statement');
const share = await page.evaluate(() => {
  const m = document.body.innerText.match(/#\/s\/[0-9a-fA-F]+/);
  return m ? m[0] : null;
});
check('the app produced a share link for the answer', !!share, share ?? '');

await page.getByRole('tab', { name: 'Statements' }).click();
await page.waitForTimeout(2500);
const listText = await page.evaluate(() => document.body.innerText);
check('the statement is listed under the name that asked',
  /Northgate Lettings/.test(listText));
await page.screenshot({ path: `${OUT}/journey-3-statements.png` });

// Follow the share link exactly as a stranger receiving it would.
const url = APP.replace(/\/$/, '') + '/' + (share ?? '#/s/none');
const stranger = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await stranger.goto(url, { waitUntil: 'domcontentloaded' });
await stranger.waitForTimeout(6000);
const text = await stranger.evaluate(() => document.body.innerText);
console.log('  share link:', url);

// The verdict names the amount, rather than only saying it was met. Asserting
// the old wording here would now fail on the fix that made it say which amount.
check('the statement page renders a verdict',
  /(Met|Did not meet)\s+£[\d,]+\.\d{2}/i.test(text),
  JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 100)));
check('it names who asked', /Northgate Lettings/.test(text));
// The threshold came from the ask and is public by design. Any other amount
// would be a leak of the record behind the answer.
const withoutThreshold = text.split('£' + AMOUNT).join('');
check('it leaks no amount beyond the threshold that was asked for',
  !/£\s?\d/.test(withoutThreshold),
  JSON.stringify((withoutThreshold.match(/£\s?[\d,.]+/g) ?? []).slice(0, 4)));
await stranger.screenshot({ path: `${OUT}/journey-4-statement.png`, fullPage: true });

check('no console errors anywhere in the journey', errors.length === 0,
  errors.slice(0, 3).join(' | '));

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
