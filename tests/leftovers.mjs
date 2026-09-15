// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The controls the other suites touched but never finished.
//
// Going back over every interactive element in App.jsx one at a time turned up
// four that were driven partially and counted as done:
//
//   * the appearance button cycles three states, and only one press was ever
//     tested, so nothing checked the labels, the icons, or that a choice
//     survives a reload;
//   * the tab strip handles ArrowLeft, Home and End as well as ArrowRight, and
//     wraps at both ends, and only ArrowRight had been pressed;
//   * "who may answer" was exercised for two holders out of four;
//   * the appearance button on the statement page is a second instance nobody
//     had clicked at all.
//
// None of this is deep, and that is the point: these are the controls a person
// touches in the first thirty seconds.
//
//   node tests/leftovers.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/leftovers';
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 150)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 150)); });

const themeState = () => page.evaluate(() => {
  const b = document.querySelector('button.themebtn');
  return {
    attr: document.documentElement.getAttribute('data-theme'),
    label: b?.getAttribute('aria-label') ?? null,
    title: b?.getAttribute('title') ?? null,
    icon: b?.textContent?.trim() ?? null,
    stored: (() => { try { return localStorage.getItem('theme'); } catch { return 'blocked'; } })(),
  };
}).catch(() => ({}));

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});
await sleep(1800);

// ===========================================================================
console.log('1. the appearance button, all the way round');
// ===========================================================================
{
  // It starts wherever a previous visit left it, so press until it is back on
  // "Match system" and walk the cycle from a known place.
  const btn = page.locator('button.themebtn').first();
  for (let i = 0; i < 4; i++) {
    const s = await themeState();
    if (s.stored === 'system' || s.attr === null) break;
    await btn.click();
    await sleep(700);
  }

  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(await themeState());
    await btn.click();
    await sleep(800);
  }
  console.log('  ' + seen.map((s) => `${s.stored}/${s.icon}/${s.title}`).join('  ->  '));

  check('L1', 'it has three states, not two',
    new Set(seen.slice(0, 3).map((s) => s.stored)).size === 3,
    seen.slice(0, 3).map((s) => s.stored).join(','));
  check('L2', 'the cycle returns to where it started',
    seen[3].stored === seen[0].stored, `${seen[0].stored} -> ${seen[3].stored}`);
  // The label is what a screen reader announces, so it has to track the state.
  const labelled = seen.slice(0, 3).every((s) =>
    (s.stored === 'system' && /Match system/i.test(s.label)) ||
    (s.stored === 'light' && /Light/i.test(s.label)) ||
    (s.stored === 'dark' && /Dark/i.test(s.label)));
  check('L3', 'the label says which appearance is chosen', labelled,
    seen.slice(0, 3).map((s) => s.label).join(' | '));
  const iconned = new Set(seen.slice(0, 3).map((s) => s.icon)).size === 3;
  check('L4', 'each state has its own icon', iconned,
    seen.slice(0, 3).map((s) => s.icon).join(' '));

  // A choice has to survive a reload, or it is not a choice.
  while ((await themeState()).stored !== 'dark') { await btn.click(); await sleep(700); }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const after = await themeState();
  check('L5', 'the chosen appearance survives a reload', after.stored === 'dark',
    `${after.stored} / ${after.attr}`);
  check('L6', 'and is actually applied to the page', after.attr === 'dark', String(after.attr));
  await page.screenshot({ path: `${OUT}/1-theme-dark.png` }).catch(() => {});

  // Put it back so later screenshots are not all dark.
  while ((await themeState()).stored !== 'system') { await btn.click(); await sleep(700); }
}

// ===========================================================================
console.log('\n2. the tab strip, every key it claims to handle');
// ===========================================================================
{
  const selected = () => page.evaluate(() => ({
    tab: document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim(),
    focused: document.activeElement?.textContent?.trim(),
  })).catch(() => ({}));

  const first = page.getByRole('tab', { name: 'Your record' });
  await first.focus();
  await sleep(500);

  await page.keyboard.press('End');
  await sleep(700);
  let s = await selected();
  check('L7', 'End jumps to the last tab', s.tab === 'Statements', s.tab ?? '');
  check('L8', 'and focus goes with it', s.focused === s.tab, `${s.focused} / ${s.tab}`);

  await page.keyboard.press('Home');
  await sleep(700);
  s = await selected();
  check('L9', 'Home jumps back to the first', s.tab === 'Your record', s.tab ?? '');

  // Left from the first tab has to wrap to the last, which is the case a
  // modulo is usually written wrong for.
  await page.keyboard.press('ArrowLeft');
  await sleep(700);
  s = await selected();
  check('L10', 'ArrowLeft from the first tab wraps to the last',
    s.tab === 'Statements', s.tab ?? '');

  await page.keyboard.press('ArrowRight');
  await sleep(700);
  s = await selected();
  check('L11', 'ArrowRight from the last wraps to the first',
    s.tab === 'Your record', s.tab ?? '');

  // A key it does not handle must not swallow the event or move anything.
  const before = (await selected()).tab;
  await page.keyboard.press('PageDown');
  await sleep(600);
  check('L12', 'a key it does not handle changes nothing',
    (await selected()).tab === before, before ?? '');
  await page.screenshot({ path: `${OUT}/2-tabs-keyboard.png` }).catch(() => {});
}

// ===========================================================================
console.log('\n3. who may answer: every holder, not just two');
// ===========================================================================
{
  await page.getByRole('tab', { name: 'Asking' }).click();
  await sleep(1200);
  const holders = state.holders ?? [];
  const bind = page.locator('#bind');
  for (const h of holders) {
    await bind.selectOption(h.id);
    await sleep(400);
    const value = await bind.inputValue();
    check(`L13-${h.id}`, `"Only ${h.label}" can be chosen`, value === h.id, `${value}`);
  }
  await bind.selectOption('');
  await sleep(400);
  check('L14', 'and it can be set back to anyone',
    (await bind.inputValue()) === '', await bind.inputValue());
}

// ===========================================================================
console.log('\n4. the appearance button on the statement page');
// ===========================================================================
{
  const id = state.verdicts?.[0]?.id;
  if (!id) {
    console.log('  skipped: no statement on chain');
  } else {
    await page.goto(`${APP}/#/s/${id}`, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    const btn = page.locator('button.themebtn').first();
    check('L15', 'the statement page has an appearance button', await btn.count() > 0);
    const before = await themeState();
    await btn.click();
    await sleep(900);
    const after = await themeState();
    check('L16', 'it works there too', before.stored !== after.stored,
      `${before.stored} -> ${after.stored}`);
    // The statement is the page a stranger lands on, so the choice has to hold
    // when they walk into the app from it.
    await page.evaluate(() => { window.location.hash = '#/'; });
    await sleep(2200);
    const inApp = await themeState();
    check('L17', 'and the choice carries into the app',
      inApp.stored === after.stored, `${after.stored} -> ${inApp.stored}`);
    await page.screenshot({ path: `${OUT}/4-statement-theme.png` }).catch(() => {});
    while ((await themeState()).stored !== 'system') { await btn.click().catch(() => {}); await sleep(700); }
  }
}

check('L-err', 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

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
