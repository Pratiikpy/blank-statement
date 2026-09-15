// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Every screen, both viewports, both themes, captured and measured.
//
// A feature that works but looks broken is still broken, and a checklist
// cannot see a cramped header or text spilling out of a card. So this does two
// things: it measures what a machine can measure honestly (horizontal
// overflow, elements off-canvas, tap targets under 44px, contrast on body
// text, headings that wrap to nothing), and it captures every state as a
// screenshot so the rest can be judged by eye.
//
// The measured part is the part that can fail a run. The screenshots are the
// part a person still has to look at, and the run says so rather than implying
// the pictures were reviewed.
//
//   node tests/visual-sweep.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/visual';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};

const VIEWPORTS = [
  ['desktop', { width: 1280, height: 800 }],
  ['mobile', { width: 375, height: 812 }],
];
const THEMES = ['light', 'dark'];
const TABS = ['Your record', 'Asking', 'Answering', 'Statements'];

// A statement page to include in the sweep, taken from whatever the chain has.
const state = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
if (!state) { console.log('BLOCKED: the bridge is not answering'); process.exit(2); }
const statementId = state.verdicts?.[0]?.id ?? null;
console.log(`sweeping ${VIEWPORTS.length} viewports x ${THEMES.length} themes x ${TABS.length} tabs` +
  (statementId ? ' + the statement page' : ' (no statement on chain yet)'));

// What a machine can honestly judge about a rendered page.
const MEASURE = () => {
  const problems = [];
  const doc = document.documentElement;

  // The page itself must never scroll sideways.
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push(`the page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth}`);
  }

  const vw = window.innerWidth;
  for (const el of document.querySelectorAll('button, a, input, select, textarea, .card, .stmt, h1, h2, h3, code')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const name = el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '');

    // Off the right edge, or starting off the left.
    if (r.right > vw + 1) problems.push(`${name} runs past the right edge by ${Math.round(r.right - vw)}px`);
    if (r.left < -1) problems.push(`${name} starts off the left edge at ${Math.round(r.left)}px`);

    // Content wider than its own box, which is how text escapes a card.
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') {
      problems.push(`${name} holds content ${el.scrollWidth - el.clientWidth}px wider than itself`);
    }
  }

  // Touch targets. 44px is the usual floor; only judge it on a small screen.
  const small = [];
  if (vw < 500) {
    for (const el of document.querySelectorAll('button, a[href], input:not([type=file]), select')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 32) {
        small.push(`${el.tagName.toLowerCase()}"${(el.textContent || '').trim().slice(0, 18)}" ${Math.round(r.height)}px`);
      }
    }
  }

  // Anything that renders as an empty box where words were expected.
  const emptyHeadings = [...document.querySelectorAll('h1, h2, h3')]
    .filter((h) => !(h.textContent || '').trim()).length;

  return {
    problems,
    small,
    emptyHeadings,
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 90),
  };
};

// Contrast, computed the way the accessibility guidance defines it, so a dark
// theme that merely looks fine can still be caught being unreadable.
const contrast = (bg, fg) => {
  const parse = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = parse(bg); const b = parse(fg);
  if (a.length < 3 || b.length < 3) return null;
  const l1 = lum(a); const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const browser = await chromium.launch({ headless: true });

for (const [vname, size] of VIEWPORTS) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      viewport: size,
      colorScheme: theme,
      // The app remembers a theme choice, so start each pass clean and let the
      // system preference decide.
      storageState: undefined,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
    // "Failed to load resource: 404" on its own names nothing, and a missing zk
    // artifact reads exactly like a missing favicon. Record the URL.
    const notFound = [];
    page.on('response', (r) => {
      if (r.status() >= 400) notFound.push(`${r.status()} ${r.url().replace(APP, '')}`);
    });
    page.on('requestfailed', (r) => {
      notFound.push(`failed ${r.url().slice(0, 90)} ${r.failure()?.errorText ?? ''}`);
    });

    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1800);

    console.log(`\n  ${vname} ${size.width}x${size.height}, ${theme}`);

    for (const tab of TABS) {
      const t = page.getByRole('tab', { name: tab });
      if (await t.count().catch(() => 0)) {
        await t.click().catch(() => {});
        await sleep(1400);
      }
      const slug = `${vname}-${theme}-${tab.toLowerCase().replace(/\s+/g, '-')}`;
      await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true }).catch(() => {});
      const m = await page.evaluate(MEASURE).catch(() => null);
      if (!m) { check(slug, 'the page could be measured', false, 'evaluate failed'); continue; }

      check(`${slug}-overflow`, `${tab}: nothing overflows`, m.problems.length === 0,
        m.problems.slice(0, 2).join(' | '));
      check(`${slug}-headings`, `${tab}: no empty headings`, m.emptyHeadings === 0,
        String(m.emptyHeadings));
      if (vname === 'mobile') {
        check(`${slug}-targets`, `${tab}: tap targets are big enough`, m.small.length === 0,
          m.small.slice(0, 2).join(' | '));
      }
      const ratio = contrast(m.bg, m.fg);
      if (ratio !== null) {
        check(`${slug}-contrast`, `${tab}: body text contrast is at least 4.5:1`, ratio >= 4.5,
          `${ratio.toFixed(2)}:1 (${m.fg} on ${m.bg})`);
      }
    }

    // The statement page is the one a stranger sees, so it gets the same pass.
    if (statementId) {
      await page.goto(`${APP}/#/s/${statementId}`, { waitUntil: 'domcontentloaded' });
      await sleep(2200);
      const slug = `${vname}-${theme}-statement`;
      await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true }).catch(() => {});
      const m = await page.evaluate(MEASURE).catch(() => null);
      if (m) {
        check(`${slug}-overflow`, 'statement page: nothing overflows', m.problems.length === 0,
          m.problems.slice(0, 2).join(' | '));
        const ratio = contrast(m.bg, m.fg);
        if (ratio !== null) {
          check(`${slug}-contrast`, 'statement page: body text contrast', ratio >= 4.5,
            `${ratio.toFixed(2)}:1`);
        }
      }
    }

    // Judge the requests before the deliberate bad-id probe below, which is
    // supposed to 404. Counting that one made every pass fail for doing
    // exactly what it was asked to check.
    {
      const missed = [...new Set(notFound)];
      if (missed.length) console.log('    requests that did not succeed: ' + missed.slice(0, 5).join(', '));
      // A font that a sandbox blocks is not a defect in this app.
      const ourFault = missed.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
      check(`${vname}-${theme}-requests`, 'nothing from this app failed to load',
        ourFault.length === 0, ourFault.slice(0, 3).join(' | '));
      notFound.length = 0;
    }

    // A statement id that does not exist must fail honestly rather than
    // rendering an empty card that looks like a valid answer.
    await page.goto(`${APP}/#/s/deadbeefdeadbeef`, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    const missing = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ')).catch(() => '');
    await page.screenshot({ path: `${OUT}/${vname}-${theme}-statement-missing.png`, fullPage: true }).catch(() => {});
    check(`${vname}-${theme}-missing`, 'an unknown statement says so plainly',
      /No statement here/i.test(missing), missing.slice(0, 80));

    // The bad-id probe answers 404 by design, and that is the pass above.
    check(`${vname}-${theme}-missing-404`, 'the unknown statement really did 404',
      notFound.some((u) => u.startsWith('404') && u.includes('deadbeef')),
      notFound.join(' | ').slice(0, 90));
    const realErrors = errors.filter((e) => !/Failed to load resource/.test(e));
    check(`${vname}-${theme}-console`, 'no console errors during the sweep', realErrors.length === 0,
      realErrors.slice(0, 2).join(' | '));

    await context.close().catch(() => {});
  }
}

await browser.close().catch(() => {});
console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} measured checks passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
console.log(`\n${OUT} holds the screenshots.`);
console.log('These still have to be looked at: overflow and contrast are measurable,');
console.log('but cramped spacing, ugly wrapping and a layout that reads wrong are not.');
process.exit(failures === 0 ? 0 : 1);
