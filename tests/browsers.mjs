// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Does the product work in a browser that is not Chromium?
//
// The rest of this project's UI testing runs through a Chrome extension, which
// can only ever say "it works in Chrome". This drives the same core journey in
// Firefox and WebKit (Safari's engine) through Playwright, and reports honestly
// which engines could actually be launched on this machine.
import { chromium, firefox, webkit } from 'playwright';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const ENGINES = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];

const results = [];

for (const [name, engine] of ENGINES) {
  const r = { engine: name };
  let browser;
  try {
    browser = await engine.launch();
  } catch (e) {
    r.launched = false;
    r.reason = String(e?.message ?? e).split('\n').find((l) => l.trim()) ?? 'unknown';
    results.push(r);
    continue;
  }
  r.launched = true;
  r.version = browser.version();
  try {
    const ctx = await browser.newContext();
    const consoleErrors = [];
    const failedRequests = [];
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 120)));
    page.on('requestfailed', (req) => failedRequests.push(req.url().slice(0, 80)));

    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab', { timeout: 20000 });
    // Wait for the bridge's first answer rather than a fixed sleep.
    await page.waitForFunction(() => !!document.querySelector('.statrow .stat'), null, { timeout: 30000 })
      .catch(() => {});

    r.title = await page.title();
    r.tabs = await page.locator('.tab').allInnerTexts();
    r.wordmark = (await page.locator('.brand').innerText()).replace(/\s+/g, ' ');
    r.recordTiles = await page.locator('.statrow .stat').allInnerTexts()
      .then((t) => t.map((x) => x.replace(/\n/g, ' ')));

    // Walk every tab and confirm each panel renders.
    r.panels = {};
    for (const label of ['Asking', 'Answering', 'Statements', 'Your record']) {
      await page.getByRole('tab', { name: label }).click();
      await page.waitForTimeout(500);
      r.panels[label] = await page.locator('[role=tabpanel]').getAttribute('id');
    }

    // The parser is the part most likely to differ between engines.
    r.previewFromSample = await (async () => {
      await page.getByRole('tab', { name: 'Your record' }).click();
      await page.getByRole('button', { name: 'Use a sample' }).click();
      await page.waitForTimeout(800);
      return page.locator('.statrow').first().innerText().then((t) => t.replace(/\n/g, ' '));
    })();

    // Intl formatting and BigInt maths, the two things engines disagree about.
    r.money = await page.evaluate(async () => {
      const m = await import('/money.mjs').catch(() => null);
      return m ? { display: m.money(2045099n), canonical: m.moneyInput(2045099n) } : 'module not reachable';
    });

    r.consoleErrors = consoleErrors;
    r.failedRequests = failedRequests;
    await ctx.close();
  } catch (e) {
    r.error = String(e?.message ?? e).split('\n')[0].slice(0, 200);
  } finally {
    await browser.close();
  }
  results.push(r);
}

for (const r of results) {
  console.log('\n=== ' + r.engine + ' ===');
  if (!r.launched) { console.log('  DID NOT LAUNCH: ' + r.reason); continue; }
  console.log('  version        ', r.version);
  if (r.error) { console.log('  FAILED: ' + r.error); continue; }
  console.log('  title          ', r.title);
  console.log('  wordmark       ', r.wordmark);
  console.log('  tabs           ', JSON.stringify(r.tabs));
  console.log('  record tiles   ', JSON.stringify(r.recordTiles));
  console.log('  panels         ', JSON.stringify(r.panels));
  console.log('  sample preview ', r.previewFromSample);
  console.log('  money          ', JSON.stringify(r.money));
  console.log('  console errors ', r.consoleErrors.length, r.consoleErrors.slice(0, 3));
  console.log('  failed requests', r.failedRequests.length);
}
process.exit(0);
