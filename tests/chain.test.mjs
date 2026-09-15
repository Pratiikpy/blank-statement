// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Checkpoint-chain tests. The claim being tested is that a long history costs
// the same to prove as a short one: one Merkle proof covers a run of batches,
// because each checkpoint names its predecessor.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadContract, makeSim, call, publicState, rejects, anchorRun, freshState,
  b32, ZERO, CPS, BATCH, HOUR, now,
} from './sim.mjs';

let C;
before(async () => { C = await loadContract(); });

const fresh = () => {
  const ps = freshState();
  return { sim: makeSim(C, ps), ps };
};

describe('anchoring a batch', () => {
  test('one transaction anchors eight receipts', () => {
    const { sim } = fresh();
    const id = call(sim, 'anchorCheckpoint', ZERO, b32('r0'));
    assert.equal(publicState(sim).issued, 1n, 'one batch, one anchor');
    assert.ok(publicState(sim).receipts.findPathForLeaf(id), 'the checkpoint must be in the tree');
  });

  test('a duplicated counterparty inside a batch is rejected at anchor time', () => {
    const { sim, ps } = fresh();
    const dupes = [...CPS]; dupes[3] = dupes[0];
    ps.batchCps = dupes;
    sim.ctx.currentPrivateState = ps;
    rejects(() => call(sim, 'anchorCheckpoint', ZERO, b32('r0')), 'duplicate counterparty');
  });

  test('eight batches cost eight anchors and no more', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    assert.equal(publicState(sim).issued, 8n);
  });
});

describe('folding a run of checkpoints', () => {
  test('a run of eight batches proves the sum of all of them', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('q1'), b32('acme'), ZERO, 80000n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('q1'), b32('n1'));
    assert.equal(v.met, true, '8 batches of 10000 must clear a threshold of 80000');
    assert.equal(Number(v.receiptCount), 64, 'the statement covers 64 receipts');
    assert.equal(Number(v.batches), 8);
  });

  test('one more than the true total is not met', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('q2'), b32('acme'), ZERO, 80001n, now() + BigInt(HOUR));
    assert.equal(call(sim, 'answerRequest', b32('q2'), b32('n2')).met, false);
  });

  test('concentration is judged across the whole run, not one batch', () => {
    const { sim, ps } = fresh();
    // One batch is dominated by a single receipt, but across 8 batches it is not.
    anchorRun(sim, ps, 8, (i) => (i === 0 ? [9000n, 100n, 100n, 100n, 200n, 200n, 150n, 150n] : BATCH));
    call(sim, 'createRequest', b32('q3'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    const v = call(sim, 'answerRequest', b32('q3'), b32('n3'));
    assert.equal(v.concentrationOk, true, '9000 against a 80000 total is not dominant');
  });
});

describe('the chain cannot be faked', () => {
  test('a broken link is rejected', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    // Rewrite one link so it names the wrong predecessor.
    ps.chain = ps.chain.map((c, i) => (i === 3 ? { ...c, prev: b32('not-the-real-prev') } : c));
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q4'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q4'), b32('n4')), 'broken checkpoint chain');
  });

  test('inflating a batch total is rejected, because it changes the commitment', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    ps.chain = ps.chain.map((c, i) => (i === 0 ? { ...c, total: 999999n } : c));
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q5'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q5'), b32('n5')), 'newest checkpoint is not the anchored one');
  });

  test('inflating a batch count is rejected the same way', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    ps.chain = ps.chain.map((c, i) => (i === 0 ? { ...c, count: 64n } : c));
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q8'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q8'), b32('n8')), 'newest checkpoint is not the anchored one');
  });

  test('a run whose newest checkpoint was never anchored is rejected', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    // Keep a valid path, but present a chain that starts from an unanchored head.
    const bogus = {
      prev: ps.chain[1] ? C.pureCircuits.checkpointIdOf(ps.chain[1], ps.chainRands[1]) : ZERO,
      total: 10000n, count: 8n, largest: 2200n,
    };
    ps.chain = [bogus, ...ps.chain.slice(1)];
    ps.chainRands = [b32('rand-forged'), ...ps.chainRands.slice(1)];
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q6'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q6'), b32('n6')), 'newest checkpoint is not the anchored one');
  });

  test('a valid path for the wrong leaf fails the root check', () => {
    const { sim, ps } = fresh();
    const made = anchorRun(sim, ps, 8);
    // Present the run truthfully but hand in the path of an older checkpoint.
    // The leaf no longer equals the head of the run.
    ps.path = publicState(sim).receipts.findPathForLeaf(made[0].id);
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q10'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q10'), b32('n10')),
      'newest checkpoint is not the anchored one');
  });

  test('a forged root is rejected by checkRoot', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    // Keep the leaf, corrupt the sibling path, so the recomputed root is not one
    // the ledger has ever held.
    const path = ps.path;
    const broken = {
      ...path,
      path: path.path.map((step, i) => (i === 0 ? { ...step, sibling: { field: 12345n } } : step)),
    };
    ps.path = broken;
    sim.ctx.currentPrivateState = ps;
    call(sim, 'createRequest', b32('q11'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    rejects(() => call(sim, 'answerRequest', b32('q11'), b32('n11')), 'checkpoint not in tree');
  });
});

describe('what reaches the public ledger', () => {
  test('no batch total and no receipt amount appears in public state', () => {
    const { sim, ps } = fresh();
    anchorRun(sim, ps, 8);
    call(sim, 'createRequest', b32('q7'), b32('acme'), ZERO, 1000n, now() + BigInt(HOUR));
    call(sim, 'answerRequest', b32('q7'), b32('n7'));
    const blob = JSON.stringify(publicState(sim), (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const a of BATCH) assert.ok(!blob.includes(String(a)), `amount ${a} must not be public`);
    assert.ok(!blob.includes('10000'), 'a batch total must not be public');
    assert.ok(!blob.includes('80000'), 'the run total must not be public');
  });
});
