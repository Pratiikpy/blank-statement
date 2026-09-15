// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Shared rig for the probes that need a real chain: deploy the contract, anchor
// a run of checkpoints, and hand back everything a statement needs. The circuit
// suites cover behaviour offline; these three answer questions only a live
// ledger can (contention, fee sponsorship).
import * as Midday from '@no-witness-labs/midday-sdk';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(__dirname, '../contracts/out');
export const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);

export const NET = {
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8188/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8188/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
};

export const b32 = (s) => {
  const u = new Uint8Array(32);
  u.set(new TextEncoder().encode(String(s)).slice(0, 32));
  return u;
};
export const ZERO = new Uint8Array(32);
export const RUN_LENGTH = 8;
export const BATCH = [1200n, 900n, 1500n, 700n, 2200n, 400n, 1800n, 1300n]; // 10000 per batch

export const witnesses = {
  holderSk:            ({ privateState }) => [privateState, privateState.sk],
  batchAmounts:        ({ privateState }) => [privateState, privateState.batchAmounts],
  batchCounterparties: ({ privateState }) => [privateState, privateState.batchCps],
  batchCount:          ({ privateState }) => [privateState, privateState.batchCount],
  chain:               ({ privateState }) => [privateState, privateState.chain],
  chainRands:          ({ privateState }) => [privateState, privateState.chainRands],
  membership:          ({ privateState }) => [privateState, privateState.path],
};

export function freshState(sk = b32('holder-secret-key-alpha')) {
  return {
    sk,
    batchAmounts: BATCH,
    batchCps: Array.from({ length: 8 }, (_, i) => b32('counterparty-' + i)),
    batchCount: BigInt(BATCH.length),
    chain: undefined,
    chainRands: undefined,
    path: undefined,
  };
}

/** Deploy a fresh contract with the given private state. */
export async function deploy(privateStateId, ps, clientOpts = {}) {
  const client = await Midday.Client.create({
    seed: Midday.Config.DEV_WALLET_SEED,
    networkConfig: NET,
    privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
    ...clientOpts,
  });
  const contract = await client.loadContract({
    module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
    privateStateId, witnesses, initialPrivateState: ps,
  });
  const dep = await contract.deploy({ initialPrivateState: ps });
  return { client, contract, dep };
}

/**
 * Anchor a run of RUN_LENGTH checkpoints and leave `ps` holding the run and a
 * membership path for its head. Takes RUN_LENGTH transactions.
 */
export async function anchorRun(dep, ps, tag = 'probe') {
  const made = [];
  let prev = ZERO;
  for (let i = 0; i < RUN_LENGTH; i++) {
    const rand = b32(`${tag}-rand-${i}`);
    ps.batchAmounts = BATCH;
    ps.batchCount = BigInt(BATCH.length);
    await dep.actions.anchorCheckpoint(prev, rand);
    const cp = {
      prev,
      total: BATCH.reduce((a, b) => a + b, 0n),
      count: BigInt(BATCH.length),
      largest: BATCH.reduce((a, b) => (b > a ? b : a), 0n),
    };
    const id = C.pureCircuits.checkpointIdOf(cp, rand);
    made.push({ cp, rand, id });
    prev = id;
    process.stdout.write(`  anchored ${i + 1}/${RUN_LENGTH}\n`);
  }
  const newestFirst = made.slice().reverse();
  const st = await dep.ledgerState();
  ps.chain = newestFirst.map((m) => m.cp);
  ps.chainRands = newestFirst.map((m) => m.rand);
  ps.path = st.receipts.findPathForLeaf(newestFirst[0].id);
  return made;
}

export const inAnHour = () => BigInt(Math.floor(Date.now() / 1000) + 3600);
export const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160);
