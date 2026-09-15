// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Make every assert in the circuit actually fire.
//
// The app carries a written refusal for each of these, and until now not one of
// them had ever been produced. A message nobody has seen fire is a guess: it
// may be unreachable, it may say the wrong thing, or the assert it names may
// not be the one that trips.
//
// These cannot be reached through the interface, because the interface builds
// honest witnesses. So this drives the contract directly and lies to it: a run
// whose links do not match, a run whose head is not the leaf that was proven, a
// batch that miscounts itself, a repeated counterparty, a nullifier replayed.
// The chain has to refuse every one.
//
// This is the part of the product a reviewer cannot see and has to take on
// trust. It is also the part where a silent acceptance would let someone prove
// something untrue, so it is worth more than any screen.
//
//   node tests/circuit-asserts.mjs
import {
  C, witnesses, deploy, anchorRun, freshState,
  b32, ZERO, BATCH, inAnHour, firstLine,
} from './probe.mjs';

let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};
const note = (msg) => console.log(`  ....  ${msg}`);

// Every refusal the app is ready to turn into a sentence. A refusal the chain
// can produce that is missing here reaches a user as a raw assert.
const APP_KNOWS = new Set([
  'request expired',
  'request already answered',
  'statement already used',
  'no such request',
  'request id already used',
  'not the holder this was asked of',
  'duplicate counterparty',
  'broken checkpoint chain',
  'newest checkpoint is not the anchored one',
  'checkpoint not in tree',
  'a counted slot holds no receipt',
  'an uncounted slot holds a receipt',
]);

console.log('deploying a contract and anchoring an honest run first\n');
const ps = freshState();
const { dep } = await deploy('circuit-asserts', ps);
console.log('contract at', dep.address);
const made = await anchorRun(dep, ps, 'assert');

// Keep a pristine copy; every case tampers with one thing and puts it back.
const good = {
  chain: ps.chain.slice(),
  chainRands: ps.chainRands.slice(),
  path: ps.path,
  batchAmounts: BATCH.slice(),
  batchCps: ps.batchCps.slice(),
  batchCount: ps.batchCount,
};
const restore = () => {
  ps.chain = good.chain.slice();
  ps.chainRands = good.chainRands.slice();
  ps.path = good.path;
  ps.batchAmounts = good.batchAmounts.slice();
  ps.batchCps = good.batchCps.slice();
  ps.batchCount = good.batchCount;
};

let n = 0;
const newAsk = async (threshold = 1n) => {
  const id = b32('assert-ask-' + (++n));
  await dep.actions.createRequest(id, b32('Assert Ltd'), ZERO, threshold, inAnHour());
  return id;
};

const expectRefusal = (id, label, expected, err) => {
  if (!err) { check(id, label, false, 'THE CHAIN ACCEPTED IT'); return false; }
  const matched = err.includes(expected);
  check(id, label, matched, matched ? expected : err);
  if (matched) {
    check(id + '-copy', `the app has a sentence for "${expected}"`, APP_KNOWS.has(expected),
      APP_KNOWS.has(expected) ? '' : 'a user would see the raw assert');
  }
  return matched;
};

/** Tamper, answer, expect a refusal, put everything back. */
const answerMustRefuse = async (id, label, expected, tamper) => {
  restore();
  tamper();
  const ask = await newAsk();
  let err = null;
  try { await dep.actions.answerRequest(ask, b32('nonce-' + n)); }
  catch (e) { err = firstLine(e); }
  finally { restore(); }
  return expectRefusal(id, label, expected, err);
};

/** The same, for the anchoring circuit, which owns two of the asserts. */
const anchorMustRefuse = async (id, label, expected, tamper) => {
  restore();
  tamper();
  let err = null;
  try { await dep.actions.anchorCheckpoint(ZERO, b32('tamper-' + (++n))); }
  catch (e) { err = firstLine(e); }
  finally { restore(); }
  return expectRefusal(id, label, expected, err);
};

console.log('\n=== the run has to be a real chain ===\n');

// Newest first, each entry naming its predecessor. Break one link and the whole
// run has to fail, or a holder could splice in history that never happened.
await answerMustRefuse('Z1', 'a run whose links do not match is refused',
  'broken checkpoint chain', () => {
    ps.chain = ps.chain.map((cp, i) => (i === 3 ? { ...cp, prev: b32('not-the-real-prev') } : cp));
  });

// The blinding value is part of a checkpoint's id, so changing one breaks the
// link above it.
await answerMustRefuse('Z2', 'a run with a swapped blinding value is refused',
  'broken checkpoint chain', () => {
    ps.chainRands = ps.chainRands.map((r, i) => (i === 5 ? b32('different-rand') : r));
  });

// The interesting one: inflating a total restates history. It has to fail for
// the same structural reason, which is what makes the total unforgeable.
await answerMustRefuse('Z3', 'inflating a total inside the run is refused',
  'broken checkpoint chain', () => {
    ps.chain = ps.chain.map((cp, i) => (i === 2 ? { ...cp, total: cp.total * 10n } : cp));
  });

console.log('\n=== the newest checkpoint has to be the anchored one ===\n');

// The membership path proves one leaf. A run headed at a different checkpoint
// has to fail even though every checkpoint in it is real.
await answerMustRefuse('Z4', 'a run whose head is not the proven leaf is refused',
  'newest checkpoint is not the anchored one', () => {
    ps.chain = [ps.chain[1], ...ps.chain.slice(1)];
    ps.chainRands = [ps.chainRands[1], ...ps.chainRands.slice(1)];
  });

// And a checkpoint that is real, and proven, but proven against a different
// tree.
//
// Hand-editing the path object does not test this: the runtime type-checks the
// witness and rejects a spread copy as the wrong shape before any assert runs,
// which is a refusal about the shape of the lie rather than the lie itself. So
// the path here is a genuine one from a second contract. Its leaf matches the
// run head, so the first assert passes; its root belongs to another tree, so
// the second has to catch it.
{
  restore();
  note('deploying a second contract so there is a second tree to borrow a path from');
  const otherPs = freshState(b32('holder-secret-key-beta'));
  const { dep: otherDep } = await deploy('circuit-asserts-other', otherPs);

  const rand = b32('other-tree-rand');
  otherPs.batchAmounts = BATCH.slice();
  otherPs.batchCount = BigInt(BATCH.length);
  await otherDep.actions.anchorCheckpoint(ZERO, rand);
  const cp = {
    prev: ZERO,
    total: BATCH.reduce((a, b) => a + b, 0n),
    count: BigInt(BATCH.length),
    largest: BATCH.reduce((a, b) => (b > a ? b : a), 0n),
  };
  const leaf = C.pureCircuits.checkpointIdOf(cp, rand);
  const otherState = await otherDep.ledgerState();
  const foreignPath = otherState.receipts.findPathForLeaf(leaf);
  note(`borrowed a path from ${otherDep.address.slice(0, 12)}…`);

  if (!foreignPath) {
    check('Z5', 'a checkpoint proven against another tree is refused', false,
      'UNTESTED: the second tree gave no path for its own leaf');
  } else {
    await answerMustRefuse('Z5', 'a checkpoint proven against another tree is refused',
      'checkpoint not in tree', () => {
        // A run headed by the other tree's checkpoint, so the leaf matches.
        ps.chain = [cp, ...good.chain.slice(1)];
        ps.chainRands = [rand, ...good.chainRands.slice(1)];
        ps.path = foreignPath;
      });
  }
}

console.log('\n=== a batch has to count itself honestly ===\n');

// Claiming more receipts than the batch holds would let padding pass as real
// history and inflate the published receipt count.
await anchorMustRefuse('Z6', 'a batch that claims more receipts than it holds is refused',
  'a counted slot holds no receipt', () => {
    ps.batchAmounts = [1200n, 900n, 0n, 0n, 0n, 0n, 0n, 0n];
    ps.batchCount = 8n;
  });

// The other direction: a real receipt sitting in a slot the count ignores.
await anchorMustRefuse('Z7', 'a batch hiding a receipt it did not count is refused',
  'an uncounted slot holds a receipt', () => {
    ps.batchAmounts = BATCH.slice();
    ps.batchCount = 3n;
  });

// Two receipts from the same payer in one batch would count one payment twice.
await anchorMustRefuse('Z8', 'a batch naming the same client twice is refused',
  'duplicate counterparty', () => {
    ps.batchCps = ps.batchCps.map((c, i) => (i === 4 ? ps.batchCps[1] : c));
  });

console.log('\n=== a statement answers once ===\n');

// The nullifier is hash(tag, sk, nonce). Reusing a nonce across two asks has to
// be refused the second time, or one proof could answer everything.
{
  restore();
  const askA = await newAsk();
  const nonce = b32('the-same-nonce');
  let first = null;
  try { await dep.actions.answerRequest(askA, nonce); } catch (e) { first = firstLine(e); }
  check('Z9', 'the first answer with a nonce is accepted', first === null, first ?? '');

  const askB = await newAsk();
  let second = null;
  try { await dep.actions.answerRequest(askB, nonce); } catch (e) { second = firstLine(e); }
  expectRefusal('Z10', 'reusing the same nonce on another ask is refused',
    'statement already used', second);
}

console.log('\n=== the honest path still works after all that ===\n');
{
  restore();
  const before = await dep.ledgerState();
  let count = 0;
  for (const _ of before.verdicts) count++;

  const ask = await newAsk(1n);
  let err = null;
  try { await dep.actions.answerRequest(ask, b32('honest-nonce')); }
  catch (e) { err = firstLine(e); }
  check('Z11', 'an untampered answer is still accepted', err === null, err ?? '');

  const after = await dep.ledgerState();
  let now = 0;
  for (const _ of after.verdicts) now++;
  check('Z12', 'and it left a verdict on the ledger', now === count + 1, `${count} -> ${now}`);
}

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
process.exit(failures === 0 ? 0 : 1);
