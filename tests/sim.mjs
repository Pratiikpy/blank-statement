// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Shared rig for the circuit suites. It drives the compiled contract through a
// CircuitContext, so every assertion in the circuit can be tripped without a
// node, a proof server, or a wallet.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(__dirname, '../contracts/out');

export const b32 = (s) => {
  const u = new Uint8Array(32);
  u.set(new TextEncoder().encode(String(s)).slice(0, 32));
  return u;
};
export const ZERO = new Uint8Array(32);
export const ALICE = b32('alice-secret-key');
export const MALLORY = b32('mallory-secret-key');
export const CPS = Array.from({ length: 8 }, (_, i) => b32('counterparty-' + i));
export const BATCH = [1200n, 900n, 1500n, 700n, 2200n, 400n, 1800n, 1300n]; // 10000, max 2200
export const HOUR = 3600;
export const now = () => BigInt(Math.floor(Date.now() / 1000));

export const witnesses = {
  holderSk:            ({ privateState }) => [privateState, privateState.sk],
  batchAmounts:        ({ privateState }) => [privateState, privateState.batchAmounts],
  batchCounterparties: ({ privateState }) => [privateState, privateState.batchCps],
  batchCount:          ({ privateState }) => [privateState, privateState.batchCount],
  chain:               ({ privateState }) => [privateState, privateState.chain],
  chainRands:          ({ privateState }) => [privateState, privateState.chainRands],
  membership:          ({ privateState }) => [privateState, privateState.path],
};

/**
 * A bare path is not a module specifier on Windows: `C:\...` reads as a URL
 * scheme and the import fails before the file is ever opened.
 */
export async function loadContract() {
  return import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
}

export function makeSim(C, ps) {
  const contract = new C.Contract(witnesses);
  const init = contract.initialState(createConstructorContext(ps, '0'.repeat(64)));
  const ctx = createCircuitContext(
    sampleContractAddress(), init.currentZswapLocalState, init.currentContractState, init.currentPrivateState);
  return { contract, ctx, C };
}

export function call(sim, name, ...args) {
  const r = sim.contract.impureCircuits[name](sim.ctx, ...args);
  sim.ctx = r.context;
  return r.result;
}

export const publicState = (sim) => sim.C.ledger(sim.ctx.currentQueryContext.state);

export const rejects = (fn, needle) => {
  try { fn(); } catch (e) {
    const m = String(e?.message ?? e);
    assert.ok(m.includes(needle), `expected "${needle}", got: ${m}`);
    return;
  }
  assert.fail(`expected a rejection mentioning "${needle}"`);
};

/** How many slots in a batch hold real money. Padding sits at zero. */
export const realCount = (amts) => amts.filter((a) => a !== 0n).length;

/**
 * Anchor `n` batches, chaining each to the last, and leave the private state
 * holding the run newest-first with a membership path for its head. This is
 * what an import produces.
 */
export function anchorRun(sim, ps, n, amountsPerBatch = () => BATCH) {
  const made = [];
  let prev = ZERO;
  for (let i = 0; i < n; i++) {
    const rand = b32('rand-' + i);
    const amts = amountsPerBatch(i);
    ps.batchAmounts = amts;
    ps.batchCps = CPS;
    ps.batchCount = BigInt(realCount(amts));
    sim.ctx.currentPrivateState = ps;
    call(sim, 'anchorCheckpoint', prev, rand);
    const cp = {
      prev,
      total: amts.reduce((a, b) => a + b, 0n),
      count: BigInt(realCount(amts)),
      largest: amts.reduce((a, b) => (b > a ? b : a), 0n),
    };
    const id = sim.C.pureCircuits.checkpointIdOf(cp, rand);
    made.push({ cp, rand, id });
    prev = id;
  }
  const newestFirst = made.slice().reverse();
  ps.chain = newestFirst.map((m) => m.cp);
  ps.chainRands = newestFirst.map((m) => m.rand);
  ps.path = publicState(sim).receipts.findPathForLeaf(newestFirst[0].id);
  sim.ctx.currentPrivateState = ps;
  return made;
}

export function freshState(sk = ALICE) {
  return {
    sk,
    batchAmounts: BATCH,
    batchCps: CPS,
    batchCount: BigInt(BATCH.length),
    chain: undefined,
    chainRands: undefined,
    path: undefined,
  };
}
