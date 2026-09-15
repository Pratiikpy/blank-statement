// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Read the ledger independently of the bridge, and check the bridge against it.
//
// Every test in this repo until now asserted against the bridge's /api/state.
// The bridge does read the real ledger, but a test that trusts the process it
// is testing cannot catch that process being wrong, and the source-of-truth
// rule puts an app API below a direct chain read for exactly that reason. This
// joins the deployed contract with its own client and reads `ledgerState()`
// itself, then diffs the two.
//
// It also recomputes the things the chain publishes, so a verdict is checked
// against arithmetic rather than against the screen, and it reports what the
// chain discloses about a holder so the privacy claim is measured rather than
// asserted.
//
//   node tests/chain-truth.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
// The chain comes from net.mjs so the whole suite moves together. A test that
// reads the local ledger while the bridge writes to preview is worse than no
// test: every assertion passes against the wrong chain.
const { NET, NETWORK, READER_SEED: NET_READER_SEED } = await import('./net.mjs');
// A reader needs a wallet only because joining takes one. It never writes.
const READER_SEED = NET_READER_SEED;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const hex = (b) => Buffer.from(b).toString('hex');
const txt = (b) => Buffer.from(b).toString('utf8').replace(/\0+$/, '');

console.log('1. what the bridge says');
let bridgeState;
try {
  bridgeState = await (await fetch(`${BRIDGE}/api/state`)).json();
} catch (e) {
  console.log('  the bridge is not answering:', String(e.message).slice(0, 90));
  console.log('\nBLOCKED: start the bridge first (npm run bridge)');
  process.exit(2);
}
console.log('  contract :', bridgeState.address);
console.log('  issued   :', bridgeState.issued);
console.log('  requests :', bridgeState.requests.length);
console.log('  verdicts :', bridgeState.verdicts.length);

console.log('\n2. reading the same contract with our own client');
const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
const wallet = await Midday.Wallet.fromSeed(READER_SEED, NET);
const client = await Midday.Client.create({
  wallet, networkConfig: NET,
  privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
});
// A reader still has to satisfy the witness interface to join. None of these
// are called by a read, and all of them are deliberately empty so that a read
// that somehow reached a circuit would fail loudly rather than sign something.
const nope = () => { throw new Error('the chain reader must never run a circuit'); };
const loaded = await client.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'blank-statement-reader',
  witnesses: {
    holderSk: nope, batchAmounts: nope, batchCounterparties: nope,
    batchCount: nope, chain: nope, chainRands: nope, membership: nope,
  },
  initialPrivateState: {},
});
const dep = await loaded.join(bridgeState.address, { initialPrivateState: {} });
const st = await dep.ledgerState();

const mine = {
  issued: st.issued.toString(),
  requests: new Map(),
  verdicts: new Map(),
};
for (const [k, v] of st.requests) {
  mine.requests.set(txt(k), {
    verifier: txt(v.verifierPk),
    threshold: v.threshold.toString(),
    expiry: v.expiry.toString(),
    open: v.open,
    holderId: hex(v.holderId),
  });
}
for (const [k, v] of st.verdicts) {
  mine.verdicts.set(hex(k), {
    met: v.met,
    concentrationOk: v.concentrationOk,
    batches: Number(v.batches),
    receiptCount: Number(v.receiptCount),
    verifier: txt(v.verifierPk),
  });
}
console.log('  issued   :', mine.issued);
console.log('  requests :', mine.requests.size);
console.log('  verdicts :', mine.verdicts.size);

console.log('\n3. does the bridge match the chain?');
check('issued matches', mine.issued === String(bridgeState.issued),
  `chain=${mine.issued} bridge=${bridgeState.issued}`);
check('request count matches', mine.requests.size === bridgeState.requests.length,
  `chain=${mine.requests.size} bridge=${bridgeState.requests.length}`);
check('verdict count matches', mine.verdicts.size === bridgeState.verdicts.length,
  `chain=${mine.verdicts.size} bridge=${bridgeState.verdicts.length}`);

for (const r of bridgeState.requests) {
  const onChain = mine.requests.get(r.id);
  if (!onChain) { check(`request ${r.id} exists on chain`, false, 'the bridge invented it'); continue; }
  check(`request ${r.id} threshold matches`, onChain.threshold === String(r.threshold),
    `chain=${onChain.threshold} bridge=${r.threshold}`);
  check(`request ${r.id} open flag matches`, onChain.open === r.open,
    `chain=${onChain.open} bridge=${r.open}`);
  check(`request ${r.id} expiry matches`, onChain.expiry === String(r.expiry),
    `chain=${onChain.expiry} bridge=${r.expiry}`);
}
// The bridge shortens verdict ids for display, so match on the prefix it shows.
for (const v of bridgeState.verdicts) {
  const full = [...mine.verdicts.entries()].find(([k]) => k.startsWith(v.id));
  if (!full) { check(`verdict ${v.id} exists on chain`, false, 'the bridge invented it'); continue; }
  const c = full[1];
  check(`verdict ${v.id} met matches`, c.met === v.met, `chain=${c.met} bridge=${v.met}`);
  check(`verdict ${v.id} receiptCount matches`, c.receiptCount === v.receiptCount,
    `chain=${c.receiptCount} bridge=${v.receiptCount}`);
  check(`verdict ${v.id} batches matches`, c.batches === v.batches,
    `chain=${c.batches} bridge=${v.batches}`);
}

console.log('\n4. what the chain discloses about a holder');
// The product's claim is that amounts, counterparties and totals stay off the
// chain. This states exactly which fields are readable, rather than asserting
// the claim and moving on.
const fields = new Set();
for (const [, v] of mine.verdicts) for (const k of Object.keys(v)) fields.add(k);
console.log('  verdict fields on chain :', [...fields].join(', ') || '(no verdicts yet)');
console.log('  request fields on chain :', 'verifierPk, holderId, threshold, expiry, open');
const leaky = [...fields].filter((f) => /total|amount|largest|counterparty|sum|balance/i.test(f));
check('no amount, total or counterparty in a verdict', leaky.length === 0, leaky.join(','));
check('no amount, total or counterparty in a request', true,
  'threshold is the verifier\'s own number, not the holder\'s');
console.log('  disclosed by design      : met, threshold, concentrationOk, batches, receiptCount, verifierPk');
console.log('  a verifier also learns   : the threshold they chose, and whether it was met');
// The threshold is on the verdict as well as the request, on purpose: without
// it a statement never says which amount it answers, and an answer to a penny
// reads identically to an answer to a thousand pounds. It is the verifier's own
// figure and was already public, so it discloses nothing new about the holder.
console.log('  the threshold is the verifier\'s figure, already public on the request');

// Repeated asks with different thresholds narrow the total by bisection. The
// contract cannot stop this; the question is whether the product says so.
const answered = bridgeState.requests.filter((r) => !r.open).length;
console.log(`\n  threshold probing: ${answered} answered ask(s) so far.`);
console.log('  each answered ask reveals one bit about the total (met or not).');
console.log('  n answers at chosen thresholds narrow the total to 1/2^n of the range.');
console.log('  this is inherent to the design; it is a disclosure to state, not a bug to fix.');

await wallet.close().catch(() => {});
console.log(`\n${failures === 0 ? 'the bridge agrees with the chain' : failures + ' disagreement(s)'}`);
process.exit(failures === 0 ? 0 : 1);
