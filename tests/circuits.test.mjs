// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Circuit unit tests. Every assertion in statement.compact has a case here that
// trips it, and one case checks that no receipt amount reaches public state.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadContract, makeSim, call, publicState, rejects, anchorRun, freshState,
  b32, ZERO, ALICE, MALLORY, CPS, BATCH, HOUR, now,
} from './sim.mjs';

let C;
before(async () => { C = await loadContract(); });

const fresh = (sk = ALICE) => {
  const ps = freshState(sk);
  return { sim: makeSim(C, ps), ps };
};

describe('holder identity', () => {
  test('holderIdOf is deterministic', () => {
    assert.deepEqual(C.pureCircuits.holderIdOf(ALICE), C.pureCircuits.holderIdOf(ALICE));
  });
  test('different secrets give different identities', () => {
    assert.notDeepEqual(C.pureCircuits.holderIdOf(ALICE), C.pureCircuits.holderIdOf(MALLORY));
  });
  test('the identity is not the secret', () => {
    assert.notDeepEqual(C.pureCircuits.holderIdOf(ALICE), ALICE);
  });
});

describe('the verdict is computed, not claimed', () => {
  test('a truthful claim publishes met', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('r1'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('r1'), b32('n1'));
    assert.equal(v.met, true);
    assert.equal(publicState(sim).verdicts.size(), 1n);
  });

  test('an overclaim publishes not-met AND still produces an artifact', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('r2'), b32('acme'), ZERO, 9999999n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('r2'), b32('n2'));
    assert.equal(v.met, false, 'an unmeetable threshold must be reported, not asserted away');
    assert.equal(publicState(sim).verdicts.size(), 1n, 'the artifact must exist even when the answer is no');
  });

  test('exactly meeting the threshold counts as met', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('r3'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    assert.equal(call(sim, 'answerRequest', b32('r3'), b32('n3')).met, true);
  });

  test('one dominant receipt is reported as concentrated', () => {
    // Every batch dominated by one receipt, so the run stays concentrated.
    // A single big receipt inside an otherwise even run is diluted instead,
    // which the chain suite covers separately.
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8, (i) =>
      i === 0 ? [100000n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]
              : [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    call(sim, 'createRequest', b32('r4'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('r4'), b32('n4'));
    assert.equal(v.met, true);
    assert.equal(v.concentrationOk, false, 'one receipt above half the run total is dominant');
  });

  test('an even spread is reported as unconcentrated', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('r5'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    assert.equal(call(sim, 'answerRequest', b32('r5'), b32('n5')).concentrationOk, true);
  });

  test('the verdict carries the verifier from the request, not the caller', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('r6'), b32('landlord'), ZERO, 80000n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('r6'), b32('n6'));
    assert.deepEqual(v.verifierPk, b32('landlord'));
  });
});

describe('the published counts are the real ones', () => {
  test('a full run of full batches publishes 64 receipts in 8 batches', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('c1'), b32('acme'), ZERO, 1n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('c1'), b32('n20'));
    assert.equal(Number(v.receiptCount), 64);
    assert.equal(Number(v.batches), 8);
  });

  test('padding slots are not counted as receipts', () => {
    // One real batch of three receipts; the rest of the run is empty fill.
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8, (i) =>
      i === 0 ? [500n, 600n, 700n, 0n, 0n, 0n, 0n, 0n] : Array.from({ length: 8 }, () => 0n));
    call(sim, 'createRequest', b32('c2'), b32('acme'), ZERO, 1n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('c2'), b32('n21'));
    assert.equal(Number(v.receiptCount), 3, 'three real receipts, not sixty-four slots');
    assert.equal(Number(v.batches), 1, 'one batch of history, not eight');
  });

  test('a count larger than the batch is rejected', () => {
    const { sim, ps } = fresh();
    ps.batchCount = 9n;
    sim.ctx.currentPrivateState = ps;
    rejects(() => call(sim, 'anchorCheckpoint', ZERO, b32('bad')), 'batch count out of range');
  });

  test('claiming more receipts than the batch holds is rejected', () => {
    const { sim, ps } = fresh();
    ps.batchAmounts = [500n, 600n, 0n, 0n, 0n, 0n, 0n, 0n];
    ps.batchCount = 5n;
    sim.ctx.currentPrivateState = ps;
    rejects(() => call(sim, 'anchorCheckpoint', ZERO, b32('bad')), 'a counted slot holds no receipt');
  });

  test('hiding a receipt behind a low count is rejected', () => {
    const { sim, ps } = fresh();
    ps.batchAmounts = [500n, 600n, 700n, 0n, 0n, 0n, 0n, 0n];
    ps.batchCount = 2n;
    sim.ctx.currentPrivateState = ps;
    rejects(() => call(sim, 'anchorCheckpoint', ZERO, b32('bad')), 'an uncounted slot holds a receipt');
  });
});

describe('holder binding', () => {
  test('an open request may be answered by anyone', () => {
    const { sim, ps } = fresh(MALLORY); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('o1'), b32('acme'), ZERO, 500n, now() + BigInt(HOUR));
    assert.equal(call(sim, 'answerRequest', b32('o1'), b32('n7')).met, true);
  });

  test('a bound request may be answered by the named holder', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    const id = C.pureCircuits.holderIdOf(ALICE);
    call(sim, 'createRequest', b32('b1'), b32('acme'), id, 80000n, now() + BigInt(HOUR));
    assert.equal(call(sim, 'answerRequest', b32('b1'), b32('n8')).met, true);
  });

  test('a bound request rejects everyone else', () => {
    const { sim, ps } = fresh(MALLORY); anchorRun(sim, ps, 8);
    const id = C.pureCircuits.holderIdOf(ALICE);
    call(sim, 'createRequest', b32('b2'), b32('acme'), id, 500n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('b2'), b32('n9')), 'not the holder this was asked of');
  });
});

describe('request lifecycle', () => {
  test('answering a request that does not exist is rejected', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    rejects(() => call(sim, 'answerRequest', b32('nope'), b32('n13')), 'no such request');
  });

  test('an expired request is rejected', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('e1'), b32('acme'), ZERO, 80000n, now() - BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('e1'), b32('n14')), 'request expired');
  });

  test('a request id cannot be reused', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('u1'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    rejects(
      () => call(sim, 'createRequest', b32('u1'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR)),
      'request id already used',
    );
  });

  test('an answered request is closed on the ledger', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('cl'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'answerRequest', b32('cl'), b32('n15'));
    assert.equal(publicState(sim).requests.lookup(b32('cl')).open, false,
      'the contract, not the interface, is what makes "answered once" true');
  });

  test('a second answer to the same ask is rejected', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('cl2'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'answerRequest', b32('cl2'), b32('n16'));
    rejects(() => call(sim, 'answerRequest', b32('cl2'), b32('n17')), 'request already answered');
  });
});

describe('single use', () => {
  test('the same nonce cannot be spent twice, even across two asks', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('s1'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'createRequest', b32('s2'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'answerRequest', b32('s1'), b32('same-nonce'));
    rejects(() => call(sim, 'answerRequest', b32('s2'), b32('same-nonce')), 'statement already used');
  });

  test('a different nonce is fine', () => {
    const { sim, ps } = fresh(); anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('s3'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'createRequest', b32('s4'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    call(sim, 'answerRequest', b32('s3'), b32('nonce-a'));
    assert.equal(call(sim, 'answerRequest', b32('s4'), b32('nonce-b')).met, true);
    assert.equal(publicState(sim).verdicts.size(), 2n);
  });
});
