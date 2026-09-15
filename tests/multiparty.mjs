// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Three people, three browsers, one statement.
//
// Every UI test in this repo so far drove one browser context and switched a
// dropdown to change who was acting. That is not what the product is: a
// verifier and a holder are different people on different machines, and the
// whole claim is that the verifier learns one sentence and nothing else. A
// single context cannot test that, because the holder's state is sitting in
// the same page.
//
// So: an isolated context per party, per QA_MASTER_GUIDE Part 5.13.
//
//   Verifier   posts the ask. Never sees the holder's record.
//   Holder     answers it from their own record.
//   Observer   a stranger with the link and nothing else. Opens the statement
//              in a context that has never loaded the app, and must still see
//              a verdict — and must not be able to reach an amount.
//
// Everything is driven the way a person drives it: type in the labelled field,
// press the button with the words on it, read what appears. Every outcome is
// then checked against the ledger, because the screen is the weakest source of
// truth there is.
//
//   node tests/multiparty.mjs
//   VIEWPORT=mobile node tests/multiparty.mjs
import { chromium } from 'playwright';
import * as Midday from '@no-witness-labs/midday-sdk';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/multiparty';
const VIEWPORT = process.env.VIEWPORT ?? 'desktop';
const SIZE = VIEWPORT === 'mobile' ? { width: 375, height: 812 } : { width: 1280, height: 800 };
// The chain comes from net.mjs so the whole suite moves together. A test that
// reads the local ledger while the bridge writes to preview is worse than no
// test: every assertion passes against the wrong chain.
const { NET, NETWORK, READER_SEED: NET_READER_SEED } = await import('./net.mjs');

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};
const hex = (b) => Buffer.from(b).toString('hex');
const txt = (b) => Buffer.from(b).toString('utf8').replace(/\0+$/, '');
const ref = `mp-${Math.random().toString(36).slice(2, 8)}`;
const THRESHOLD_POUNDS = '250.00';

// ---------------------------------------------------------------- chain truth
const bridgeState = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
if (!bridgeState) { console.log('BLOCKED: the bridge is not answering on ' + BRIDGE); process.exit(2); }
const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
const readerWallet = await Midday.Wallet.fromSeed(NET_READER_SEED, NET);
const readerClient = await Midday.Client.create({
  wallet: readerWallet, networkConfig: NET,
  privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
});
const nope = () => { throw new Error('the reader must never run a circuit'); };
const readerLoaded = await readerClient.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'blank-statement-multiparty-reader',
  witnesses: {
    holderSk: nope, batchAmounts: nope, batchCounterparties: nope,
    batchCount: nope, chain: nope, chainRands: nope, membership: nope,
  },
  initialPrivateState: {},
});
const readerDep = await readerLoaded.join(bridgeState.address, { initialPrivateState: {} });
const ledger = async () => {
  const st = await readerDep.ledgerState();
  const requests = new Map();
  const verdicts = new Map();
  let spent = 0;
  for (const [k, v] of st.requests) {
    requests.set(txt(k), {
      open: v.open, threshold: v.threshold.toString(),
      holderId: hex(v.holderId), verifier: txt(v.verifierPk),
    });
  }
  for (const [k, v] of st.verdicts) {
    verdicts.set(hex(k), {
      met: v.met, concentrationOk: v.concentrationOk,
      batches: Number(v.batches), receiptCount: Number(v.receiptCount),
      verifier: txt(v.verifierPk),
    });
  }
  for (const _ of st.spent) spent++;
  return { issued: st.issued.toString(), requests, verdicts, spent };
};

// ------------------------------------------------------------------- browsers
const browser = await chromium.launch({ headless: true });
// A context per party. Separate storage, separate cookies, separate everything:
// this is what makes "the observer has never seen the holder's record" a fact
// rather than a hope.
const makeParty = async (name) => {
  const context = await browser.newContext({ viewport: SIZE });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  const seen = [];
  page.on('response', (r) => seen.push(r.url()));
  return { name, context, page, errors, seen };
};
const shot = (party, label) =>
  party.page.screenshot({ path: `${OUT}/${VIEWPORT}-${party.name}-${label}.png`, fullPage: true })
    .catch(() => {});
const settled = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1200);
};
// The app is tabbed, so a party has to open the section they work in, exactly
// as a person would: click the word, wait for the panel.
const openTab = async (party, label) => {
  const tab = party.page.getByRole('tab', { name: label });
  if (!(await tab.count().catch(() => 0))) return false;
  await tab.click().catch(() => {});
  await sleep(1200);
  return true;
};

console.log(`multi-party run, ${VIEWPORT} ${SIZE.width}x${SIZE.height}, reference ${ref}\n`);

const verifier = await makeParty('verifier');
const holder = await makeParty('holder');
const observer = await makeParty('observer');

// ===========================================================================
console.log('1. the verifier posts an ask');
// ===========================================================================
await verifier.page.goto(APP, { waitUntil: 'domcontentloaded' });
await settled(verifier.page);
check('V0', 'the app offers its sections as tabs',
  (await verifier.page.getByRole('tab').count()) === 4,
  String(await verifier.page.getByRole('tab').count()));
await shot(verifier, '0-landing');
check('V0b', 'the verifier can open Asking', await openTab(verifier, 'Asking'));
check('V1', 'the asking form is there',
  await verifier.page.locator('text=Ask someone to show their income').count() > 0);
await shot(verifier, '1-arrived');

// Typed, not injected: a field that ignores typing is a real defect and fill()
// would hide it.
await verifier.page.locator('#who').fill('');
await verifier.page.locator('#who').type('Northgate Lettings', { delay: 12 });
await verifier.page.locator('#amt').fill('');
await verifier.page.locator('#amt').type(THRESHOLD_POUNDS, { delay: 12 });
await verifier.page.locator('#ref').fill('');
await verifier.page.locator('#ref').type(ref, { delay: 12 });
// Bind it to Alice, so the "not the holder" rule is exercised by a real user
// choosing a real option rather than by an API call.
await verifier.page.locator('#bind').selectOption('alice').catch(() => {});
await sleep(600);

const beforeAsk = await ledger();
check('V2', 'the amount field echoes what was typed',
  (await verifier.page.locator('#amt').inputValue()) === THRESHOLD_POUNDS,
  await verifier.page.locator('#amt').inputValue());
// The help text under the amount is the product explaining itself. If it reads
// wrong the user is being told the wrong thing, whatever the chain does.
const amtHelp = await verifier.page.locator('#amt-help').innerText().catch(() => '');
check('V3', 'the amount help reads back the same figure', /£250\.00/.test(amtHelp), amtHelp.slice(0, 80));
await shot(verifier, '2-filled');

await verifier.page.getByRole('button', { name: /Post the ask/i }).click();
for (let i = 0; i < 40; i++) {
  await sleep(1500);
  const busy = await verifier.page.getByRole('button', { name: /Posting the ask/i }).count();
  if (!busy) break;
}
await settled(verifier.page);
await shot(verifier, '3-posted');

const afterAsk = await ledger();
check('V4', 'the ask is on the chain', afterAsk.requests.has(ref), ref);
check('V5', 'the chain holds the threshold that was typed',
  afterAsk.requests.get(ref)?.threshold === '25000',
  afterAsk.requests.get(ref)?.threshold);
check('V6', 'the chain holds the name that was typed',
  afterAsk.requests.get(ref)?.verifier === 'Northgate Lettings',
  afterAsk.requests.get(ref)?.verifier);
check('V7', 'the ask is bound to a holder, not open to anyone',
  afterAsk.requests.get(ref)?.holderId !== '0'.repeat(64));
check('V8', 'the ask is open', afterAsk.requests.get(ref)?.open === true);
check('V9', 'the verifier sees it in Open asks',
  (await verifier.page.locator(`text=${ref}`).count()) > 0);
check('V10', 'no console errors for the verifier', verifier.errors.length === 0,
  verifier.errors.slice(0, 2).join(' | '));

// ===========================================================================
console.log('\n2. the holder answers, in their own browser');
// ===========================================================================
await holder.page.goto(APP, { waitUntil: 'domcontentloaded' });
await settled(holder.page);
check('H0', 'the holder can open Answering', await openTab(holder, 'Answering'));
await shot(holder, '1-arrived');

// The holder's record is on their device. The verifier's context must never
// have had it, and this is where that becomes checkable.
const holderRecordVisible = await holder.page.locator('text=What you are answering from').count();
check('H1', "the holder sees their own record", holderRecordVisible > 0);

await holder.page.locator('#as').selectOption('alice');
await sleep(500);
const askOptions = await holder.page.locator('#ask option').allInnerTexts().catch(() => []);
check('H2', 'the new ask is offered to the holder', askOptions.some((o) => o.includes(ref)),
  askOptions.slice(0, 3).join(' | ').slice(0, 100));
await holder.page.locator('#ask').selectOption(ref);
await sleep(800);

// Before anything is sent, the product promises to say what it will publish.
// Hold it to that promise.
const promise = await holder.page.locator('text=What this will publish').count();
check('H3', 'it says what will be published before anything is sent', promise > 0);
const promiseText = await holder.page.locator('.callout').first().innerText().catch(() => '');
check('H4', 'the promise names the threshold being answered', /£250\.00/.test(promiseText),
  promiseText.replace(/\s+/g, ' ').slice(0, 110));
check('H5', 'the promise does not name a total or a client',
  !/total of|client|counterparty/i.test(promiseText));
await shot(holder, '2-about-to-answer');

const beforeAnswer = await ledger();
await holder.page.getByRole('button', { name: /Answer it/i }).click();
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  const busy = await holder.page.getByRole('button', { name: /Working/i }).count();
  if (!busy) break;
}
await settled(holder.page);
await shot(holder, '3-answered');

const afterAnswer = await ledger();
check('H6', 'a verdict was written to the chain',
  afterAnswer.verdicts.size === beforeAnswer.verdicts.size + 1,
  `${beforeAnswer.verdicts.size} -> ${afterAnswer.verdicts.size}`);
check('H7', 'the chain closed the ask', afterAnswer.requests.get(ref)?.open === false,
  `open=${afterAnswer.requests.get(ref)?.open}`);
check('H8', 'a nullifier was spent', afterAnswer.spent === beforeAnswer.spent + 1,
  `${beforeAnswer.spent} -> ${afterAnswer.spent}`);

// Find the verdict this run produced, by difference rather than by position.
const newVerdict = [...afterAnswer.verdicts.entries()]
  .find(([k]) => !beforeAnswer.verdicts.has(k))?.[1] ?? null;
check('H9', 'the verdict names the verifier who asked',
  newVerdict?.verifier === 'Northgate Lettings', newVerdict?.verifier ?? 'none');
check('H10', 'the verdict says the amount was met', newVerdict?.met === true,
  String(newVerdict?.met));

// The share link is the artifact the holder hands over.
const shareHref = await holder.page.locator('a[href*="#/s/"], [href*="#/s/"]').first()
  .getAttribute('href').catch(() => null);
const shareText = await holder.page.locator('text=/#\\/s\\/[0-9a-f]+/').first().innerText().catch(() => '');
const shareId = (shareHref ?? shareText ?? '').match(/#\/s\/([0-9a-f]+)/)?.[1] ?? null;
check('H11', 'the holder is given a link to share', !!shareId, shareId ?? 'none found');
check('H12', 'no console errors for the holder', holder.errors.length === 0,
  holder.errors.slice(0, 2).join(' | '));

// ===========================================================================
console.log('\n3. a stranger opens the link');
// ===========================================================================
if (!shareId) {
  console.log('  skipped: there is no link to open');
} else {
  const url = `${APP}/#/s/${shareId}`;
  console.log('  ' + url);
  await observer.page.goto(url, { waitUntil: 'domcontentloaded' });
  await settled(observer.page);
  await shot(observer, '1-statement');

  const body = await observer.page.locator('body').innerText();
  check('O1', 'the statement page renders for someone who has never used the app',
    /reference/i.test(body) && body.length > 40, body.replace(/\s+/g, ' ').slice(0, 90));
  check('O2', 'it names who asked', /Northgate Lettings/.test(body));
  // The statement says whether the amount was met. It does not say WHICH
  // amount: the on-chain Verdict carries met, concentrationOk, batches,
  // receiptCount and the verifier's name, and no threshold. Recorded as the
  // finding it is, and pushed on properly in section 6.
  const namesThreshold = /£\s?250(\.00)?/.test(body);
  check('O3', 'the statement names the amount it answers', namesThreshold,
    namesThreshold ? '' : 'says "Met the amount asked for" without saying which amount');

  // The whole product claim, tested as a hostile reader: can a real amount be
  // recovered from this page? The threshold is the verifier's own number and is
  // meant to be here. Anything else that looks like money is a leak.
  const money = [...body.matchAll(/£\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => m[1]);
  const unexpected = money.filter((m) => !/^250(\.00)?$/.test(m.replace(/,/g, '')));
  check('O4', 'no amount beyond the threshold that was asked for appears',
    unexpected.length === 0, unexpected.join(', '));

  // Not just the rendered text: the page's own data. A total sitting in a
  // script tag or a fetch response is just as much a leak.
  const holderTotals = await observer.page.evaluate(() => {
    // Text and embedded data only. Reading innerHTML instead sweeps up the
    // stylesheet, where colours like #059669 and #111113 are six digits and
    // look exactly like a total. That produced a false leak report on the
    // first run: a harness bug, not a product one.
    const text = document.body.innerText;
    const data = [...document.querySelectorAll('script[type="application/json"], [data-json]')]
      .map((e) => e.textContent).join(' ');
    return [...(text + ' ' + data).matchAll(/\b\d{6,}\b/g)].map((m) => m[0]).slice(0, 10);
  });
  check('O5', 'no large bare figure is shown or embedded as data', holderTotals.length === 0,
    holderTotals.join(', '));

  // The observer's context has never loaded the app's main page, so it cannot
  // have the holder's record. Prove it rather than assume it.
  const storage = await observer.page.evaluate(() => {
    const out = { localStorage: 0, keys: [] };
    try {
      out.localStorage = window.localStorage.length;
      out.keys = Object.keys(window.localStorage).slice(0, 8);
    } catch { /* a blocked store is also fine */ }
    return out;
  });
  check('O6', 'the stranger holds no holder state', !storage.keys.some((k) => /receipt|record|holder|amount/i.test(k)),
    storage.keys.join(', ') || 'nothing stored');

  // What did the page actually ask the network for? If the statement page pulls
  // the whole app state to render one sentence, the sentence is not the only
  // thing that reached the stranger.
  const apiCalls = [...new Set(observer.seen.filter((u) => u.includes('/api/')))]
    .map((u) => u.replace(BRIDGE, '').replace(APP, ''));
  console.log('  the stranger fetched:', apiCalls.join(', ') || 'nothing');
  check('O7', 'the stranger does not fetch the holder record endpoint',
    !apiCalls.some((u) => u.includes('/api/record')), apiCalls.join(', '));
  check('O8', 'no console errors for the stranger', observer.errors.length === 0,
    observer.errors.slice(0, 2).join(' | '));
}

// ===========================================================================
console.log('\n4. the ask is spent: the holder cannot answer it twice');
// ===========================================================================
{
  await holder.page.reload({ waitUntil: 'domcontentloaded' });
  await settled(holder.page);
  await openTab(holder, 'Answering');
  await holder.page.locator('#as').selectOption('alice');
  await sleep(500);
  const stillOffered = (await holder.page.locator('#ask option').allInnerTexts().catch(() => []))
    .some((o) => o.includes(ref));
  // The interface should not offer an ask that the chain has already closed.
  check('R1', 'the answered ask is no longer offered', !stillOffered,
    stillOffered ? 'it is still in the list' : '');
}

// ===========================================================================
console.log('\n5. a second holder, at the same time, stays separate');
// ===========================================================================
{
  const other = await makeParty('holder2');
  const ref2 = `${ref}-b`;
  // The verifier posts a second ask, bound to a different person.
  await verifier.page.locator('#ref').fill('');
  await verifier.page.locator('#ref').type(ref2, { delay: 10 });
  await verifier.page.locator('#bind').selectOption('chidi').catch(() => {});
  await sleep(500);
  await verifier.page.getByRole('button', { name: /Post the ask/i }).click();
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    if (!(await verifier.page.getByRole('button', { name: /Posting the ask/i }).count())) break;
  }
  await settled(verifier.page);

  const l = await ledger();
  check('M1', 'the second ask is on the chain', l.requests.has(ref2), ref2);
  check('M2', 'it is bound to the other holder',
    l.requests.get(ref2)?.holderId !== afterAsk.requests.get(ref)?.holderId,
    'different holderId');

  // Alice must not be able to answer an ask bound to Chidi, and the interface
  // should not offer it to her.
  await holder.page.reload({ waitUntil: 'domcontentloaded' });
  await settled(holder.page);
  await openTab(holder, 'Answering');
  await holder.page.locator('#as').selectOption('alice');
  await sleep(600);
  const offeredToAlice = (await holder.page.locator('#ask option').allInnerTexts().catch(() => []))
    .filter((o) => o.includes(ref2));
  check('M3', "an ask bound to someone else is marked, not silently offered",
    offeredToAlice.length === 0 || offeredToAlice.every((o) => /only chidi/i.test(o)),
    offeredToAlice.join(' | ').slice(0, 80));

  // The real holder answers it in their own browser.
  await other.page.goto(APP, { waitUntil: 'domcontentloaded' });
  await settled(other.page);
  await openTab(other, 'Answering');
  await other.page.locator('#as').selectOption('chidi');
  await sleep(500);
  const has2 = (await other.page.locator('#ask option').allInnerTexts().catch(() => []))
    .some((o) => o.includes(ref2));
  check('M4', 'the bound holder is offered their own ask', has2);
  if (has2) {
    const before2 = await ledger();
    await other.page.locator('#ask').selectOption(ref2);
    await sleep(600);
    await other.page.getByRole('button', { name: /Answer it/i }).click();
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (!(await other.page.getByRole('button', { name: /Working/i }).count())) break;
    }
    await settled(other.page);
    await shot(other, '1-answered');
    const after2 = await ledger();
    check('M5', 'the second holder produced their own verdict',
      after2.verdicts.size === before2.verdicts.size + 1,
      `${before2.verdicts.size} -> ${after2.verdicts.size}`);
    check('M6', 'and it closed only their own ask',
      after2.requests.get(ref2)?.open === false && after2.requests.get(ref)?.open === false);
    // Chidi's record is "one client worth more than all the rest", so the
    // concentration flag is the interesting half of this verdict.
    const v2 = [...after2.verdicts.entries()].find(([k]) => !before2.verdicts.has(k))?.[1] ?? null;
    console.log('  second holder verdict:', JSON.stringify(v2));
    check('M7', 'the second verdict is a distinct statement',
      v2 !== null && v2.verifier === 'Northgate Lettings', JSON.stringify(v2));
  }
  check('M8', 'no console errors for the second holder', other.errors.length === 0,
    other.errors.slice(0, 2).join(' | '));
  await other.context.close().catch(() => {});
}

// ===========================================================================
console.log('\n6. can a statement be swapped for an easier one?');
// ===========================================================================
// The judge's question, and the one O3 raised. The on-chain Verdict holds met,
// concentrationOk, batches, receiptCount and the verifier's name. It does NOT
// hold the threshold. So if a holder answers a trivially low ask from the same
// verifier, does the resulting page look the same as one answering a high ask?
//
// If it does, a verifier who asked for 250 pounds cannot tell from the link
// alone whether they were shown an answer to 250 pounds or to a penny.
{
  const cheapRef = ref + '-cheap';
  await openTab(verifier, 'Asking');
  await verifier.page.locator('#who').fill('');
  await verifier.page.locator('#who').type('Northgate Lettings', { delay: 8 });
  await verifier.page.locator('#amt').fill('');
  await verifier.page.locator('#amt').type('0.01', { delay: 8 });
  await verifier.page.locator('#ref').fill('');
  await verifier.page.locator('#ref').type(cheapRef, { delay: 8 });
  await verifier.page.locator('#bind').selectOption('alice').catch(() => {});
  await sleep(600);
  await verifier.page.getByRole('button', { name: /Post the ask/i }).click();
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    if (!(await verifier.page.getByRole('button', { name: /Posting the ask/i }).count())) break;
  }
  await settled(verifier.page);

  const l6 = await ledger();
  check('S1', 'a one penny ask can be posted under the same name',
    l6.requests.get(cheapRef)?.threshold === '1', l6.requests.get(cheapRef)?.threshold);

  await holder.page.reload({ waitUntil: 'domcontentloaded' });
  await settled(holder.page);
  await openTab(holder, 'Answering');
  await holder.page.locator('#as').selectOption('alice');
  await sleep(600);
  const offered = (await holder.page.locator('#ask option').allInnerTexts().catch(() => []))
    .some((o) => o.includes(cheapRef));
  check('S2', 'the holder can answer the cheap ask', offered);

  if (offered) {
    await holder.page.locator('#ask').selectOption(cheapRef);
    await sleep(600);
    await holder.page.getByRole('button', { name: /Answer it/i }).click();
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (!(await holder.page.getByRole('button', { name: /Working/i }).count())) break;
    }
    await settled(holder.page);

    // The share link is rendered as text in a code block, not as an anchor, so
    // read the page rather than looking for an href. Take the id that is not
    // the one from the first answer.
    const cheapBodyText = await holder.page.locator('body').innerText().catch(() => '');
    const allIds = [...cheapBodyText.matchAll(/#\/s\/([0-9a-f]+)/g)].map((m) => m[1]);
    const cheapStatementId = allIds.find((x) => x !== shareId) ?? allIds[0] ?? null;
    check('S3', 'the cheap answer also produces a shareable link', !!cheapStatementId,
      cheapStatementId || 'none');

    if (cheapStatementId && shareId && cheapStatementId !== shareId) {
      const spy = await makeParty('substitute');
      await spy.page.goto(APP + '/#/s/' + cheapStatementId, { waitUntil: 'domcontentloaded' });
      await settled(spy.page);
      await shot(spy, '1-cheap-statement');
      const cheapBody = (await spy.page.locator('body').innerText()).replace(/\s+/g, ' ');

      // Strip every occurrence of the statement id, not just the one after the
      // word "reference". The share URL printed on the page contains the id
      // too, so stripping only the label leaves the URLs different and the
      // comparison passes for a reason that has nothing to do with the
      // verdict. That was a false pass on the first run.
      const strip = (t) => t
        .replace(/[0-9a-f]{16,}/gi, 'ID')
        .replace(/https?:\/\/\S+/gi, 'URL')
        .trim();
      const bodyA = strip((await observer.page.locator('body').innerText()).replace(/\s+/g, ' '));
      const bodyB = strip(cheapBody);

      console.log('  250 pound statement:', bodyA.slice(0, 130));
      console.log('  one penny statement:', bodyB.slice(0, 130));

      const distinguishable = bodyA !== bodyB;
      if (!distinguishable) {
        console.log('  the two pages are character-for-character identical once the id is removed.');
      } else {
        // Say exactly where they differ, so a pass here is a real difference
        // rather than an artefact.
        const a = bodyA.split(' ');
        const b = bodyB.split(' ');
        const at = a.findIndex((w, i) => w !== b[i]);
        console.log('  first difference at word ' + at + ': ' +
          JSON.stringify(a.slice(at, at + 8).join(' ')) + ' vs ' +
          JSON.stringify(b.slice(at, at + 8).join(' ')));
      }
      check('S4', 'a verifier can tell the two statements apart', distinguishable,
        distinguishable
          ? 'they differ'
          : 'IDENTICAL: an answer to a penny reads the same as an answer to 250 pounds');
      check('S5', 'the cheap statement names the amount it answers',
        /0\.01|1p|one penny/i.test(cheapBody), cheapBody.slice(0, 90));
      await spy.context.close().catch(() => {});
    } else {
      console.log('  skipped the comparison: no second statement id');
    }
  }
}

// ===========================================================================
console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed  (${VIEWPORT})`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
console.log(`\nscreenshots in ${OUT}`);
for (const p of [verifier, holder, observer]) await p.context.close().catch(() => {});
await browser.close().catch(() => {});
await readerWallet.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
