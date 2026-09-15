// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The whole point, tested: a write to the contract where the browser builds the
// proof and the visitor's own wallet signs and submits it. No bridge wallet, no
// server-side key.
//
// It posts an ask (`createRequest`), which needs no private receipt state, so a
// failure here is about the wallet path rather than about witnesses. The result
// is checked against the bridge's own view of the chain, because the bridge
// reads the same contract and has no idea this write came from a browser.
import { chromium } from 'playwright';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? '/tmp/lace-hgeekaiplokcnmakghbdfbgnlfheichg';
const PROFILE = process.env.PROFILE ?? '/home/zkharsh/.cache/blank-statement/lace-profile';
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-21';
const PASSWORD = LACE_PASSWORD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF = 'wallet-' + Math.random().toString(36).slice(2, 9);
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

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

// The contract the bridge deployed; the browser joins the same address.
const state = await fetch(`${BRIDGE}/api/state`).then((r) => r.json());
console.log('contract:', state.address);
console.log('reference:', REF);

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
await ext.close().catch(() => {});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
// A 404 on a zk artifact does not surface as an error: it is swallowed inside
// the proving step and the call simply never returns. Name the URL.
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url().slice(0, 130)); });
page.on('requestfailed', (r) => badResponses.push('failed ' + r.url().slice(0, 130) + ' ' + (r.failure()?.errorText ?? '')));
// Which services the page actually talks to, and in what order. The proof
// server and the indexer are the two that matter after the wallet signs.
const traffic = [];
page.on('request', (r) => {
  const u = r.url();
  if (/:6300|:8088|:9944|:8188/.test(u)) traffic.push(r.method() + ' ' + u.slice(0, 110));
});
const consoleAll = [];
page.on('console', (m) => consoleAll.push(m.type() + ': ' + m.text().slice(0, 180)));

for (let i = 0; i < 6; i++) {
  await page.goto(`${APP}/wallet-write.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  if (await page.evaluate(() => typeof window.postAsk === 'function').catch(() => false)) break;
}
check('the harness loaded the SDK in the browser',
  await page.evaluate(() => typeof window.postAsk === 'function').catch(() => false));
check('the connector is present', await page.evaluate(() => !!window.midnight).catch(() => false));

// Fire it without awaiting: the wallet may raise an approval window, and
// awaiting here would block the code that has to click it.
await page.evaluate(({ address, reference }) => {
  window.postAsk({ address, reference, verifier: 'Browser Verifier', threshold: 1000n.toString() });
}, { address: state.address, reference: REF }).catch((e) => console.log('kick threw:', e.message.slice(0, 80)));
console.log('\ncreateRequest started in the page');

// Proving in a browser is not quick, and 24 MB of prover keys download first.
for (let i = 0; i < 100; i++) {
  await sleep(6000);
  const done = await page.evaluate(() => window.__result).catch(() => null);
  if (done) break;

  for (const p of ctx.pages()) {
    if (p.isClosed() || p === page || !p.url().startsWith('chrome-extension://')) continue;
    const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '');
    if (!text) continue;
    console.log('  wallet window:', JSON.stringify(text.slice(0, 120)));
    await p.screenshot({ path: `${OUT}/lace-write-prompt.png` }).catch(() => {});
    // Order matters. "Sign transaction" opens a modal that then asks for the
    // password, so filling a password first leaves an empty box behind a
    // disabled Confirm and the run waits forever. Handle the modal if it is
    // already up, otherwise start the signature.
    // :visible matters. The prove screen keeps a password field of its own
    // behind the modal, and .first() picks that hidden one, where every action
    // waits for an actionability that never comes — the run blocks with no
    // error and no screenshot, which reads as the wallet ignoring the request.
    const pw = p.locator('input[type="password"]:visible').first();
    const confirm = p.locator('button:has-text("Confirm"):visible').first();
    if (await pw.count().catch(() => 0) && await confirm.count().catch(() => 0)) {
      console.log('  password modal: filling and confirming');
      await pw.click().catch(() => {});
      // type() rather than fill(): the Confirm button stays disabled unless the
      // field sees real keystrokes, and a disabled button swallows the click
      // silently, which looks exactly like the wallet ignoring the request.
      await pw.fill('').catch(() => {});
      await pw.type(PASSWORD, { delay: 40 }).catch((e) => console.log('  type threw:', e.message.slice(0, 60)));
      await sleep(2000);
      const enabled = await confirm.isEnabled().catch(() => false);
      console.log('  Confirm enabled:', enabled);
      await p.screenshot({ path: `${OUT}/lace-write-password.png` }).catch(() => {});
      if (enabled) {
        await confirm.click().catch((e) => console.log('  confirm threw:', e.message.slice(0, 60)));
      } else {
        await p.keyboard.press('Enter').catch(() => {});
      }
      await sleep(8000);
      const after = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200)).catch(() => '(window gone)');
      console.log('  after confirming:', JSON.stringify(after.slice(0, 160)));
      await p.screenshot({ path: `${OUT}/lace-write-after-confirm.png` }).catch(() => {});
      continue;
    }
    // Authorize stays disabled until an account is chosen, and the account is a
    // plain row rather than a button, so has-text on buttons never finds it.
    const authorize = p.locator('button:has-text("Authorize")').first();
    if (await authorize.count().catch(() => 0) && !(await authorize.isEnabled().catch(() => false))) {
      const row = p.getByText(/Midnight #\d/).first();
      if (await row.count().catch(() => 0)) {
        console.log('  choosing the Midnight account');
        await row.click().catch((e) => console.log('  row threw:', e.message.slice(0, 50)));
        await sleep(2500);
      }
    }
    // The main extension gates Authorize behind picking an account.
    for (const label of ['Select Account', 'Midnight', 'Sign transaction', 'Authorize', 'Allow', 'Approve', 'Sign', 'Submit']) {
      const b = p.locator(`button:has-text("${label}"):visible`).first();
      if (await b.count().catch(() => 0) && await b.isEnabled().catch(() => false)) {
        console.log('  pressing', label);
        await b.click().catch(() => {});
        await sleep(4000);
        break;
      }
    }
  }
  if (i % 5 === 4) {
    console.log('  …', (await page.evaluate(() => window.__log).catch(() => '')).split('\n').slice(-1)[0]);
  }
}

const result = await page.evaluate(() => window.__result).catch(() => null);
const log = await page.evaluate(() => window.__log).catch(() => '');
console.log('\npage log:');
for (const l of String(log).split('\n').filter(Boolean)) console.log('   ' + l);
await page.screenshot({ path: `${OUT}/lace-write-result.png` }).catch(() => {});

check('the browser produced a result', !!result, JSON.stringify(result ?? null).slice(0, 200));
check('the write succeeded', result?.ok === true, result?.message ?? '');
check('it reported a transaction hash', !!result?.txHash, result?.txHash ?? '');

// The bridge reads the same contract and knows nothing about this write.
if (result?.ok) {
  let seen = null;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(6000);
    const s = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
    seen = (s?.requests ?? []).find((r) => r.id === REF) ?? null;
  }
  check('the chain shows the ask the browser posted', !!seen, JSON.stringify(seen ?? null).slice(0, 200));
  check('it carries the name the browser sent', seen?.verifier === 'Browser Verifier', seen?.verifier ?? '');
}

console.log('\nservices the page called:');
for (const t of [...new Set(traffic)].slice(0, 20)) console.log('   ' + t);
if (!traffic.length) console.log('   (none - it never reached the proof server or the indexer)');
console.log('\nlast console lines:');
for (const c of consoleAll.slice(-12)) console.log('   ' + c);

if (badResponses.length) {
  console.log('\nrequests that did not succeed:');
  for (const b of [...new Set(badResponses)].slice(0, 12)) console.log('   ' + b);
}
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`);
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
