// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Two things my DOM checks could not answer.
//
// 1. What a screen reader is actually handed. `page.accessibility.snapshot()`
//    returns the accessibility tree the platform API exposes — the same thing
//    NVDA or VoiceOver reads. It is not a screen reader, and it cannot tell you
//    how something sounds or whether the reading order is pleasant, but it does
//    show every node's role and name, which is what my DOM sweep was guessing at.
//
// 2. A phone, as closely as this machine can get: a real device profile with a
//    mobile user agent, device pixel ratio, and genuine touch events rather than
//    a narrow desktop window. Not a real handset, and it proves nothing about
//    an on-screen keyboard or a back gesture.
import { chromium, webkit, devices } from 'playwright';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';

const browser = await chromium.launch();

// ---------- 1. the accessibility tree ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector('.statrow .stat'), null, { timeout: 30000 }).catch(() => {});

  for (const tab of ['Your record', 'Asking', 'Answering', 'Statements']) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(500);
    // ariaSnapshot is the accessibility tree as the platform exposes it, which
    // is the same thing a screen reader is handed.
    const yaml = await page.locator('body').ariaSnapshot();
    const lines = yaml.split('\n').filter((l) => l.trim());
    const interactive = lines.filter((l) => /- (button|link|textbox|combobox|checkbox|tab|listbox|option)/.test(l));
    const unnamed = interactive.filter((l) => !/["']/.test(l));
    console.log(`\n=== accessibility tree: ${tab} (${lines.length} nodes) ===`);
    for (const l of lines.slice(0, 18)) console.log('  ' + l.replace(/^\s*/, (m) => m));
    if (lines.length > 18) console.log(`  … ${lines.length - 18} more`);
    console.log('  interactive nodes:', interactive.length, '| with no accessible name:', unnamed.length);
    if (unnamed.length) for (const u of unnamed.slice(0, 4)) console.log('    UNNAMED:', u.trim());
  }
  await ctx.close();
}

// ---------- 2. a device profile with real touch ----------
const PROFILES = ['iPhone 13', 'Pixel 7', 'iPad Mini'];
for (const name of PROFILES) {
  const profile = devices[name];
  if (!profile) { console.log(`\n=== ${name}: profile not in this Playwright build ===`); continue; }
  const ctx = await browser.newContext({ ...profile });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 90)); });
  page.on('pageerror', (e) => problems.push('pageerror ' + String(e.message).slice(0, 90)));

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 20000 });
  await page.waitForTimeout(2500);

  // Drive it by tapping, which is what a phone does.
  await page.getByRole('tab', { name: 'Asking' }).tap();
  await page.waitForTimeout(600);
  await page.getByRole('tab', { name: 'Your record' }).tap();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Use a sample' }).tap();
  await page.waitForTimeout(900);

  const audit = await page.evaluate(() => {
    const de = document.documentElement;
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.right > de.clientWidth + 1 || r.left < -1) over.push(String(el.className).slice(0, 22));
    }
    const small = [];
    for (const el of document.querySelectorAll('button, select, textarea, label.btn, input:not([type=file])')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.height < 44 || r.width < 44) small.push(String(el.className).slice(0, 18) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return {
      width: de.clientWidth,
      dpr: window.devicePixelRatio,
      touch: 'ontouchstart' in window,
      hScroll: de.scrollWidth > de.clientWidth,
      overflow: over.slice(0, 3),
      tapUnder44: small,
      previewShown: !!document.querySelector('.statrow .stat'),
    };
  });
  const file = `${OUT}/device-${name.toLowerCase().replace(/\s+/g, '-')}.png`;
  await page.screenshot({ path: file });
  console.log(`\n=== ${name} ===`);
  console.log('  css width', audit.width, '| dpr', audit.dpr, '| touch events', audit.touch);
  console.log('  tapped through Asking -> Your record -> Use a sample; preview rendered:', audit.previewShown);
  console.log('  horizontal scroll', audit.hScroll, '| overflow', audit.overflow, '| tap targets under 44px', audit.tapUnder44);
  console.log('  console problems', problems.length, problems.slice(0, 2));
  console.log('  screenshot', file);
  await ctx.close();
}

await browser.close();
process.exit(0);
