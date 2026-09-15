// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Lace Midnight Preview, loaded for real, against this app.
//
// Three questions, in order:
//   1. Does Lace inject the CAIP-372 connector the SDK looks for, and does the
//      app's wallet surface see it? This needs no wallet to be created.
//   2. What does the app do when a person clicks Connect and the wallet has no
//      account yet? That is the state every first-time visitor is in.
//   3. Can Lace target a local `undeployed` network at all? That has been an
//      open question in the notes since the beginning.
//
// One thing costs an hour if you do not know it: Chrome disables an unpacked
// extension unless developer mode is on, and a disabled extension still starts
// its service worker once before Chrome shuts it down. That looks exactly like
// a flaky injection race. It is not. Turn developer mode on first and the
// connector appears on the very first page load, every time.
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.APP ?? 'http://127.0.0.1:5177/';
const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// Chrome's extensions page hides everything behind nested shadow roots, so both
// helpers below walk into them rather than querying the light DOM.
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

const ITEM_STATE = `(() => {
  const items = [];
  const hunt = (root, depth) => {
    if (!root || depth > 12) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'EXTENSIONS-ITEM' && el.shadowRoot) {
        items.push({
          id: el.id,
          name: el.shadowRoot.querySelector('#name')?.textContent?.trim(),
          on: el.shadowRoot.querySelector('#enableToggle')?.getAttribute('aria-pressed') === 'true',
        });
      }
      if (el.shadowRoot) hunt(el.shadowRoot, depth + 1);
    }
  };
  hunt(document, 0);
  return items;
})()`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'lace-profile-')), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
await sleep(6000);

// --- 1. The extension itself -------------------------------------------------
const extPage = await ctx.newPage();
await extPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(3000);

const before = await extPage.evaluate(ITEM_STATE);
console.log('\n1. the extension');
check('Lace is installed', before.some((i) => i.name?.includes('Lace')),
  JSON.stringify(before.map((i) => i.name)));
console.log(`  note  Chrome loads it disabled (enabled=${before[0]?.on}) until developer mode is on`);

await extPage.evaluate(`(() => {
  const find = ${FIND_DEEP};
  const d = find('devMode');
  if (d && d.getAttribute('aria-pressed') !== 'true') d.click();
})()`);
await sleep(3000);
await extPage.evaluate(`(() => {
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

const after = await extPage.evaluate(ITEM_STATE);
check('developer mode enables it', after.length > 0 && after.every((i) => i.on));
check('its service worker stays alive', ctx.serviceWorkers().length > 0,
  `${ctx.serviceWorkers().length} worker(s)`);
await extPage.screenshot({ path: `${OUT}/lace-extensions-page.png`, fullPage: true }).catch(() => {});

// --- 2. What Lace injects ----------------------------------------------------
// Toggling developer mode reloads the extension, and for a short while after
// that its worker does not answer the injected script. A person would reload
// the page; so does this, and it reports how many loads it actually took.
const page = await ctx.newPage();
let loads = 0;
for (let attempt = 1; attempt <= 6; attempt++) {
  loads = attempt;
  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('.tab', { timeout: 30000 }).catch(() => {});
  await sleep(7000);
  if (await page.evaluate(() => !!window.midnight).catch(() => false)) break;
}

const injected = await page.evaluate(() => ({
  present: !!window.midnight,
  connectors: window.midnight
    ? Object.entries(window.midnight).map(([key, v]) => ({
        key,
        name: v?.name ?? null,
        apiVersion: v?.apiVersion ?? null,
        connect: typeof v?.connect,
        isEnabled: typeof v?.isEnabled,
      }))
    : [],
}));
console.log('\n2. what Lace injects');
console.log(`  page loads needed: ${loads}`);
check('window.midnight exists', injected.present);
const lace = injected.connectors.find((c) => c.name === 'lace');
check('a connector named "lace"', !!lace, JSON.stringify(injected.connectors));
check('apiVersion is at least 4', Number((lace?.apiVersion ?? '0').split('.')[0]) >= 4,
  `apiVersion=${lace?.apiVersion}`);
check('it exposes connect()', lace?.connect === 'function');

// --- 3. What the app makes of it ---------------------------------------------
const pill = await page.evaluate(() => ({
  text: document.querySelector('.walletpill')?.textContent.trim().slice(0, 120),
  dot: document.querySelector('.walletpill .dot')?.className,
  offersConnect: !!document.querySelector('.walletpill .linkbtn'),
}));
console.log('\n3. what the app says');
console.log('  pill:', JSON.stringify(pill.text));
check('it stops saying there is no wallet', !/No Midnight wallet/i.test(pill.text ?? ''));
check('it names the wallet it found', /lace/i.test(pill.text ?? ''));
check('it offers a Connect button', pill.offersConnect);
await page.screenshot({ path: `${OUT}/lace-detected.png` });

// --- 4. The first-time visitor: connect before any account exists ------------
console.log('\n4. clicking Connect with no Lace account created');
if (pill.offersConnect) {
  await page.locator('.walletpill .linkbtn').first().click()
    .catch((e) => console.log('  click threw:', e.message.slice(0, 80)));
  await sleep(15000);

  const settled = await page.evaluate(() => {
    const note = document.querySelector('.walletnote');
    const seen = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 &&
        r.width > 1 && r.height > 1;
    };
    return {
      text: ((document.querySelector('.walletpill')?.textContent ?? '') + ' ' + (note?.textContent ?? '')).trim().slice(0, 260),
      dot: document.querySelector('.walletpill .dot')?.className,
      noteText: note?.textContent?.trim() ?? null,
      noteVisible: seen(note),
    };
  }).catch(() => ({ text: '(page gone)', dot: '', noteVisible: false }));
  console.log('  pill:', JSON.stringify(settled.text));
  console.log('  dot :', settled.dot);
  check('the app does not claim to be connected', !/^Connected/i.test(settled.text ?? ''),
    'a wallet with no account cannot be connected');
  check('the app stays on its feet', !!settled.text && settled.text !== '(page gone)');
  // Lace reports both "you pressed reject" and "there is no account yet" as
  // code Rejected, so the sentence must not accuse a first-time visitor of
  // declining something they never saw.
  check('it does not accuse the visitor of declining', !/you declined/i.test(settled.text ?? ''),
    JSON.stringify(settled.text));
  check('it points at finishing wallet setup', /set(ting)? one up|try again/i.test(settled.text ?? ''));
  // A wallet names itself and Lace picks "lace", so any sentence built around
  // that name starts lower case unless the app raises it. Check the rule, not
  // this one string, because every wallet message is built the same way.
  const sentence = (settled.text ?? '').replace(/^Connect wallet/, '');
  check('its sentence starts with a capital', /^[A-Z]/.test(sentence.trim()),
    JSON.stringify(sentence.trim().slice(0, 60)));
  // A tooltip needs a mouse and a hover, so on a phone it does not exist. The
  // refusal has to be readable on the page itself.
  check('the refusal is visible on the page, not just a tooltip', settled.noteVisible,
    JSON.stringify(settled.noteText?.slice(0, 70) ?? null));
  await page.screenshot({ path: `${OUT}/lace-connect-result.png` });

  const wins = ctx.pages().filter((p) => !p.isClosed() && p.url().startsWith('chrome-extension://'));
  console.log('  Lace windows opened:', wins.length);
  for (const [i, p] of wins.entries()) {
    const t = await p.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
    console.log(`   window ${i}: ` + JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 220)));
    await p.screenshot({ path: `${OUT}/lace-window-${i}.png` }).catch(() => {});
  }
}

// --- 5. Local network support, straight from the manifest --------------------
console.log('\n5. can Lace point at a local undeployed node');
const csp = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))
  .content_security_policy?.extension_pages ?? '';
for (const host of ['http://localhost:9944', 'http://localhost:8088', 'http://localhost:6300']) {
  check(`its CSP allows ${host}`, csp.includes(host));
}
console.log('  node 9944, indexer 8088, proof server 6300 are the local stack ports');

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
