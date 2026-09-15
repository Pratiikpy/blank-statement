// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Onboard the *main* Lace extension with a Midnight account.
//
// Why not the preview build: it signs a transaction and then never returns the
// result to the page, so every write hangs forever with no error. That was
// proved with a plain makeTransfer, which contains none of this project's code
// (see COVERAGE.md). Its own banner says Midnight moved here.
//
// The main extension's UI is React Native Web: controls are divs carrying
// data-testid, not buttons, and its inputs ignore fill() — they need real
// keystrokes before the next button enables.
//
// The wallet this creates is a fixture: a throwaway profile, a phrase generated
// here and used nowhere else, funds from a local dev chain that resets.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-main';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-main-profile';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(PROFILE, { recursive: true });

const FIND_DEEP = `(id) => {
  const hunt = (root, depth) => {
    if (!root || depth > 12) return null;
    const hit = root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const r = hunt(el.shadowRoot, depth + 1); if (r) return r; }
    }
    return null;
  };
  return hunt(document, 0);
}`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
await sleep(6000);

const ext = await ctx.newPage();
await ext.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(3000);
await ext.evaluate(`(() => { const f = ${FIND_DEEP}; const d = f('devMode'); if (d && d.getAttribute('aria-pressed') !== 'true') d.click(); })()`);
await sleep(3000);
await ext.evaluate(`(() => {
  const hunt = (root, depth) => {
    if (!root || depth > 12) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'EXTENSIONS-ITEM' && el.shadowRoot) {
        const t = el.shadowRoot.querySelector('#enableToggle');
        if (t && t.getAttribute('aria-pressed') !== 'true') t.click();
      }
      if (el.shadowRoot) hunt(el.shadowRoot, depth + 1);
    }
  };
  hunt(document, 0);
})()`);
await sleep(6000);
const sw = ctx.serviceWorkers()[0];
const extId = sw ? new URL(sw.url()).host : 'gafhhkghbfjjkeiendhlofajokpaflmk';
console.log('extension enabled, workers:', ctx.serviceWorkers().length);
await ext.close().catch(() => {});

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1000 });
await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' });
await sleep(12000);

const snapshot = () => ui.evaluate(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  return {
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 240),
    testids: [...new Set([...document.querySelectorAll('[data-testid]')].filter(vis)
      .map((el) => el.getAttribute('data-testid')))],
    inputs: [...document.querySelectorAll('input')].filter(vis)
      .map((i) => ({ t: i.getAttribute('data-testid'), type: i.type })),
  };
}).catch(() => ({ testids: [], inputs: [], text: '' }));

const tap = async (testid) => {
  const el = ui.locator(`[data-testid="${testid}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  await el.click().catch((e) => console.log(`  ${testid} threw:`, e.message.slice(0, 50)));
  await sleep(5000);
  return true;
};

console.log('\n1. welcome');
console.log('  ' + (await snapshot()).text.slice(0, 120));
await ui.screenshot({ path: `${OUT}/main-lace-01-welcome.png` }).catch(() => {});
await tap('onboarding-start-create-wallet-button');

let phrase = null;
for (let step = 2; step <= 16; step++) {
  const s = await snapshot();
  console.log(`\n${step}. ${s.text.slice(0, 110)}`);
  await ui.screenshot({ path: `${OUT}/main-lace-${String(step).padStart(2, '0')}.png` }).catch(() => {});

  // Midnight is not on by default; this is the whole reason for using this build.
  if (s.testids.includes('onboarding-create-wallet-toggle-midnight')) {
    console.log('  activating the Midnight account');
    await tap('onboarding-create-wallet-toggle-midnight');
  }

  for (const t of s.testids.filter((t) => /checkbox|accept|agree|terms|written|saved/i.test(t))) {
    await ui.locator(`[data-testid="${t}"]`).first().click().catch(() => {});
    await sleep(1000);
  }

  // Passwords need real keystrokes here; fill() leaves the next button disabled.
  for (const f of s.inputs.filter((f) => f.type === 'password' && f.t)) {
    const el = ui.locator(`[data-testid="${f.t}"]`).first();
    await el.click().catch(() => {});
    await el.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1000);
  }

  // The phrase, when shown, then typed back on the screen that asks for it.
  const shown = await ui.evaluate(() => {
    const pairs = [...document.body.innerText.matchAll(/(\d{1,2})[.)]?\s+([a-z]{3,})/g)];
    const byIndex = new Map();
    for (const [, n, w] of pairs) if (!byIndex.has(Number(n))) byIndex.set(Number(n), w);
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  }).catch(() => []);
  if (!phrase && shown.length >= 12) {
    phrase = shown;
    writeFileSync(`${PROFILE}/RECOVERY.txt`,
      `local test fixture only - do not reuse\n\n${phrase.join(' ')}\n\npassword: ${PASSWORD}\n`);
    console.log(`  recovery phrase read (${phrase.length} words), saved beside the profile`);
  }
  const wordInputs = s.inputs.filter((f) => f.type !== 'password' && /mnemonic|word/i.test(f.t ?? ''));
  if (phrase && wordInputs.length) {
    console.log(`  typing the phrase back into ${wordInputs.length} fields`);
    for (const [i, f] of wordInputs.entries()) {
      const el = ui.locator(`[data-testid="${f.t}"]`).nth(0);
      await el.type(phrase[i] ?? '', { delay: 15 }).catch(() => {});
    }
    await sleep(2000);
  }

  const forward = s.testids.find((t) => /^next-btn$|finish|continue|enter-wallet|got-it|done/i.test(t));
  if (!forward) {
    console.log('  no forward control; this is where it stops');
    console.log('  testids:', JSON.stringify(s.testids).slice(0, 400));
    break;
  }
  console.log('  taking:', forward);
  await tap(forward);
  await sleep(3000);

  // "Your new Wallet" is still onboarding, so matching on the word wallet ends
  // the run three screens early. Only the wallet's own controls mean arrival.
  const now = await snapshot();
  if (now.testids.some((t) => /receive|send-button|total-balance|activity/i.test(t))) {
    console.log('\nlanded in the wallet');
    break;
  }
}

const end = await snapshot();
console.log('\nfinal screen:', end.text.slice(0, 200));
await ui.screenshot({ path: `${OUT}/main-lace-final.png`, fullPage: true }).catch(() => {});
console.log('profile:', PROFILE);
await ctx.close().catch(() => {});
process.exit(0);
