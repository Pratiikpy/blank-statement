// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Record the product being used, start to finish, as a video.
//
// Everything on screen is the real app driving a real chain. Nothing is mocked
// and no frame is composed — if a proof takes eleven seconds, the recording
// contains eleven seconds of it. That is the point: a hand-edited take becomes
// a claim the viewer has to trust, and this product is about not asking for
// trust.
//
// Playwright's recordVideo ignores deviceScaleFactor and CSS zoom, so the only
// way to get a crisp frame is a native viewport equal to recordVideo.size. We
// record 1600x900 and upscale to 3840x2160 with ffmpeg lanczos afterwards,
// from bash rather than from here — the Windows shell mangles the -vf filter
// when node spawns it.
//
//   node demo/record.mjs
//   bash demo/to-4k.sh
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? 'demo/out';
mkdirSync(OUT, { recursive: true });

const W = 1600, H = 900;
const t0 = Date.now();
const marks = [];
/** A beat the edit can cut to, timed from the first frame. */
const beat = (name) => {
  const at = ((Date.now() - t0) / 1000).toFixed(1);
  marks.push({ at: Number(at), name });
  console.log(`  ${String(at).padStart(6)}s  ${name}`);
};
const hold = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A cursor the camera can see.
 *
 * Playwright moves a real pointer but renders nothing, so a recording of it
 * looks like a page operating itself. This draws one and moves it in steps, so
 * a viewer can follow what is being pressed and why.
 */
const CURSOR = `
  (() => {
    // addInitScript can run before <body> exists; retry on DOM ready.
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => window.__mkcur?.()); }
    if (document.getElementById('__cur')) return;
    if (!document.body) return;
    const c = document.createElement('div');
    c.id = '__cur';
    c.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:0', 'top:0',
      'width:22px', 'height:22px', 'pointer-events:none',
      'transform:translate(-2px,-2px)',
      'transition:left .18s cubic-bezier(.3,.7,.3,1),top .18s cubic-bezier(.3,.7,.3,1)',
    ].join(';');
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22">' +
      '<path d="M2 2 L2 16 L6 12.5 L8.6 18.4 L11.4 17.2 L8.8 11.4 L14 11 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    window.__cur = (x, y) => { c.style.left = x + 'px'; c.style.top = y + 'px'; };
    window.__tap = () => {
      c.animate([{ transform: 'translate(-2px,-2px) scale(1)' },
                 { transform: 'translate(-2px,-2px) scale(.72)' },
                 { transform: 'translate(-2px,-2px) scale(1)' }], { duration: 220 });
    };
  })();
`;

const page = {};

/** Move the drawn cursor and the real pointer together, then settle. */
async function moveTo(p, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return null;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await p.evaluate(([a, b]) => window.__cur?.(a, b), [x, y]).catch(() => {});
  await p.mouse.move(x, y);
  await hold(320);
  return { x, y };
}

async function click(p, locator, settle = 900) {
  const at = await moveTo(p, locator);
  if (!at) { console.log('    (nothing to click)'); return false; }
  await p.evaluate(() => window.__tap?.()).catch(() => {});
  await hold(140);
  await locator.click({ timeout: 20000 }).catch((e) =>
    console.log('    click failed:', e.message.split('\n')[0].slice(0, 60)));
  await hold(settle);
  return true;
}

/** Type at a readable speed. Instant text reads as a paste, not as a person. */
async function type(p, locator, text, delay = 55) {
  await moveTo(p, locator);
  await locator.click({ timeout: 15000 }).catch(() => {});
  await locator.fill('').catch(() => {});
  await locator.type(text, { delay }).catch(() => {});
  await hold(420);
}

const ref = 'demo-' + Math.random().toString(36).slice(2, 7);

console.log('recording; every second on screen is real\n');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const p = await ctx.newPage();
await p.addInitScript(CURSOR);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

try {
  // -------------------------------------------------------------------------
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.evaluate(CURSOR).catch(() => {});
  await hold(2200);
  beat('the product');

  // -------------------------------------------------------------------------
  // Your record — the foundation. Receipts become an anchored run.
  // -------------------------------------------------------------------------
  await click(p, p.getByRole('tab', { name: 'Your record' }), 1400);
  beat('your record');
  await hold(1600);

  const sample = p.getByRole('button', { name: /Use a sample/i });
  if (await sample.count().catch(() => 0)) {
    await click(p, sample, 1800);
    beat('a year of receipts, pasted');
    await hold(2000);
  }

  // -------------------------------------------------------------------------
  // The ask. A verifier wants one fact, and names the number themselves.
  // -------------------------------------------------------------------------
  await click(p, p.getByRole('tab', { name: 'Asking' }), 1400);
  beat('a verifier asks');
  await hold(1200);

  await type(p, p.locator('#who'), 'Northgate Lettings');
  await type(p, p.locator('#amt'), '250');
  await hold(600);

  const bind = p.locator('#bind');
  if (await bind.count().catch(() => 0)) {
    await moveTo(p, bind);
    await bind.selectOption('alice').catch(() => {});
    await hold(900);
    beat('bound to one person');
  }
  await type(p, p.locator('#ref'), ref, 40);
  await hold(700);

  await click(p, p.getByRole('button', { name: /^Post the ask$/i }), 2500);
  beat('posted to the chain');
  // A real write. However long it takes is however long the video shows.
  for (let i = 0; i < 60; i++) {
    const posted = await p.locator(`text=${ref}`).count().catch(() => 0);
    if (posted) break;
    await hold(1000);
  }
  await hold(1800);
  beat('it is on the ledger');

  // -------------------------------------------------------------------------
  // Answering. The disclosure is shown before anything is sent, not after.
  // -------------------------------------------------------------------------
  await click(p, p.getByRole('tab', { name: 'Answering' }), 1600);
  beat('the holder sees it');
  await hold(1500);

  const as = p.locator('#as');
  if (await as.count().catch(() => 0)) {
    await moveTo(p, as);
    await as.selectOption('alice').catch(() => {});
    await hold(1000);
  }
  const ask = p.locator('#ask');
  if (await ask.count().catch(() => 0)) {
    await moveTo(p, ask);
    const vals = await ask.locator('option').evaluateAll((os) =>
      os.map((o) => o.value).filter(Boolean)).catch(() => []);
    const mine = vals.find((v) => v.includes(ref)) ?? vals[0];
    if (mine) await ask.selectOption(mine).catch(() => {});
    await hold(1200);
  }
  beat('what this will publish, before sending');
  await hold(3200);

  await click(p, p.getByRole('button', { name: /^Answer it$/i }), 2000);
  beat('proving');
  for (let i = 0; i < 90; i++) {
    const done = await p.locator('text=/#\\/s\\//').count().catch(() => 0);
    if (done) break;
    await hold(1000);
  }
  await hold(2000);
  beat('settled');

  // -------------------------------------------------------------------------
  // The statement, and what it does not say.
  // -------------------------------------------------------------------------
  await click(p, p.getByRole('tab', { name: 'Statements' }), 1600);
  beat('the statements list');
  // Wait for the row to arrive rather than guessing. The list is read from the
  // chain, and on a public network that is slower than any sleep worth writing.
  // The accessible name is the aria-label ("Open statement <id> for <who>"),
  // not the word on the button. Matching the visible text finds nothing.
  const open = p.getByRole('button', { name: /^Open statement/i }).first();
  await open.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
  await hold(1600);

  if (await open.count().catch(() => 0)) {
    await click(p, open, 1200);
    // The statement renders inline above the list, so the page has to be taken
    // back to the top: leaving the scroll where it was cuts the headline off
    // and leaves older test rows in frame instead.
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await hold(2400);
    beat('Met £250.00');
    await hold(4200);
    // The right-hand column is the whole argument: published, and never leaves.
    await p.evaluate(() => window.scrollTo({ top: 150, behavior: 'smooth' }));
    await hold(2600);
    beat('what the world sees, and what never leaves');
    await hold(5200);
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await hold(1800);
  }
} catch (e) {
  console.log('\nrecording stopped early:', String(e.message).split('\n')[0].slice(0, 120));
} finally {
  beat('end');
  // Write the timeline before anything else can fail, so an edit still has it.
  writeFileSync(`${OUT}/results.json`, JSON.stringify({
    width: W, height: H, reference: ref,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    consoleErrors: errors,
    beats: marks,
  }, null, 2));
  await ctx.close();
  await browser.close();
}

console.log(`\n${marks.length} beats, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(errors.length ? `console errors: ${errors.length}` : 'no console errors');
console.log(`webm + results.json in ${OUT}/`);
console.log('now: bash demo/to-4k.sh');
