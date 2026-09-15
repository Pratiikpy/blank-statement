// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The statement route is the page a stranger opens, so it is the one screen that
// most deserves to be looked at in every combination. This photographs both
// outcomes across both themes and both viewports, in Chromium and Firefox, and
// audits each shot for the things a screenshot alone would not tell you.
import { chromium, firefox, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21/statement';
mkdirSync(OUT, { recursive: true });

const res = await fetch(`${BRIDGE}/api/state`, { headers: { origin: 'http://127.0.0.1:5177' } });
const state = await res.json();
const met = state.verdicts.find((v) => v.met);
const notMet = state.verdicts.find((v) => !v.met);
if (!met || !notMet) {
  console.log('need one met and one not-met statement on chain; found',
    state.verdicts.map((v) => (v.met ? 'met' : 'not-met')).join(', ') || 'none');
  process.exit(1);
}
console.log('met     ', met.id, met.receiptCount + ' receipts /', met.batches, 'batches');
console.log('not met ', notMet.id, notMet.receiptCount + ' receipts /', notMet.batches, 'batches');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 900 },
];
const OUTCOMES = [['met', met.id], ['notmet', notMet.id]];
const problems = [];
const shots = [];

for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  const browser = await engine.launch();
  for (const vp of VIEWPORTS) {
    for (const theme of ['light', 'dark']) {
      for (const [outcome, id] of OUTCOMES) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        const tag = `${engineName}/${vp.name}/${theme}/${outcome}`;
        page.on('console', (m) => { if (m.type() === 'error') problems.push(`${tag}: ${m.text().slice(0, 90)}`); });
        page.on('pageerror', (e) => problems.push(`${tag}: pageerror ${String(e.message).slice(0, 90)}`));
        page.on('requestfailed', (r) => problems.push(`${tag}: requestfailed ${r.url().slice(0, 60)}`));

        await page.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch {} }, theme);
        await page.goto(APP + '#/s/' + id, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.claim', { timeout: 25000 });
        await page.waitForTimeout(700);

        const file = `${OUT}/${engineName}-${vp.name}-${theme}-${outcome}.png`;
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);

        const audit = await page.evaluate(() => {
          const de = document.documentElement;
          const over = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (!r.width) continue;
            if (r.right > de.clientWidth + 1 || r.left < -1) over.push(String(el.className).slice(0, 22));
          }
          const small = [];
          for (const el of document.querySelectorAll('button, a[href]')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (r.height < 44 || r.width < 44) small.push(String(el.className).slice(0, 18));
          }
          const redacted = document.querySelectorAll('.redact').length;
          return {
            hScroll: de.scrollWidth > de.clientWidth,
            over: over.slice(0, 3),
            small,
            claim: document.querySelector('.claim')?.textContent,
            receipts: document.querySelectorAll('.meta div')[0]?.querySelector('b')?.textContent,
            batches: document.querySelectorAll('.meta div')[1]?.querySelector('b')?.textContent,
            publishedRows: document.querySelectorAll('.rowlist .row').length,
            // The one thing this page must never do: show a number it promised to hide.
            amountsOnPage: /£\s?\d/.test(document.body.innerText) ? 'A MONEY FIGURE IS VISIBLE' : 'none',
            redacted,
          };
        });
        if (audit.hScroll) problems.push(`${tag}: horizontal scroll`);
        if (audit.over.length) problems.push(`${tag}: overflow ${audit.over.join(',')}`);
        if (audit.small.length) problems.push(`${tag}: tap target ${audit.small.join(',')}`);
        if (audit.amountsOnPage !== 'none') problems.push(`${tag}: ${audit.amountsOnPage}`);
        if (audit.publishedRows !== 9) problems.push(`${tag}: disclosure list has ${audit.publishedRows} rows, expected 9`);
        console.log(`  ${tag.padEnd(34)} ${audit.claim} | ${audit.receipts} receipts / ${audit.batches} batches | amounts: ${audit.amountsOnPage}`);
        await ctx.close();
      }
    }
  }
  await browser.close();
}

console.log('\nstatement-route screenshots:', shots.length);
console.log('problems:', problems.length);
for (const p of problems) console.log('  ' + p);
process.exit(0);
