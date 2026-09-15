// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Visual proof from a non-Chromium engine. Drives the core journey in Firefox
// at both viewports and both themes and writes screenshots to disk, so the
// cross-browser claim has pictures behind it rather than a pass/fail line.
import { firefox, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const OUT = process.env.OUT ?? ('/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21/' + (process.env.ENGINE ?? 'firefox'));
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const TABS = ['Your record', 'Asking', 'Answering', 'Statements'];

const ENGINE = (process.env.ENGINE ?? 'firefox') === 'webkit' ? webkit : firefox;
const browser = await ENGINE.launch();
const shots = [];
const problems = [];

for (const vp of VIEWPORTS) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${vp.name}/${theme}: ${m.text().slice(0, 100)}`); });
    page.on('pageerror', (e) => problems.push(`${vp.name}/${theme}: pageerror ${String(e.message).slice(0, 100)}`));
    page.on('requestfailed', (r) => problems.push(`${vp.name}/${theme}: requestfailed ${r.url().slice(0, 70)}`));

    await page.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch {} }, theme);
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab', { timeout: 20000 });
    await page.waitForFunction(() => !!document.querySelector('.statrow .stat'), null, { timeout: 30000 }).catch(() => {});

    for (const label of TABS) {
      await page.getByRole('tab', { name: label }).click();
      await page.waitForTimeout(600);
      const file = `${OUT}/${vp.name}-${theme}-${label.toLowerCase().replace(/\s+/g, '-')}.png`;
      await page.screenshot({ path: file, fullPage: false });
      shots.push(file);

      // Layout audit on every screen, in this engine.
      const audit = await page.evaluate(() => {
        const de = document.documentElement;
        const over = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (!r.width) continue;
          if (r.right > de.clientWidth + 1 || r.left < -1) over.push(String(el.className).slice(0, 24));
        }
        const small = [];
        for (const el of document.querySelectorAll('button, select, textarea, label.btn, input:not([type=file])')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.height < 44 || r.width < 44) small.push(String(el.className).slice(0, 20) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
        return { hScroll: de.scrollWidth > de.clientWidth, over: over.slice(0, 4), small };
      });
      if (audit.hScroll) problems.push(`${vp.name}/${theme}/${label}: horizontal scroll`);
      if (audit.over.length) problems.push(`${vp.name}/${theme}/${label}: overflow ${audit.over.join(',')}`);
      if (audit.small.length) problems.push(`${vp.name}/${theme}/${label}: tap target ${audit.small.join(',')}`);
    }
    await ctx.close();
  }
}

// The statement page a stranger opens, in Firefox, cold.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const state = await page.evaluate(() => null).catch(() => null);
await page.goto(APP, { waitUntil: 'domcontentloaded' });
const id = await page.evaluate(async () => {
  const s = await fetch('http://127.0.0.1:8790/api/state').then((r) => r.json());
  return s.verdicts[0]?.id ?? null;
});
if (id) {
  await page.goto(APP + '#/s/' + id, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.claim', { timeout: 20000 });
  const file = `${OUT}/desktop-light-statement.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  console.log('statement claim:', await page.locator('.claim').innerText());
} else {
  console.log('statement page: no verdict on chain to open (none made since the last redeploy)');
}
await ctx.close();
await browser.close();

console.log('\nfirefox screenshots written:', shots.length);
for (const s of shots) console.log('  ' + s);
console.log('\nproblems found:', problems.length);
for (const p of problems) console.log('  ' + p);
process.exit(0);
