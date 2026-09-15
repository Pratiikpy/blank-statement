// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Can a wallet with no funds transact, with the relay paying the DUST?
//
// The honest answer so far is no, and not because the relay is wrong: the SDK
// only wires `feeRelay` into the browser wallet path, so a seed-based client
// silently ignores the option and tries to fund itself. This probe is what
// establishes that, and it is expected to report FAILED with an
// insufficient-funds cause until a Lace-backed path exists.
import * as Midday from '@no-witness-labs/midday-sdk';
import { C, CONTRACT_DIR, NET, witnesses, deploy, anchorRun, freshState, b32, firstLine } from './probe.mjs';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:3002';

// 1. Funded genesis wallet deploys a contract to talk to, and anchors a run so
//    there is something a statement could be made against.
const ps = freshState();
const { dep } = await deploy('gasless-owner', ps);
console.log('contract deployed by funded wallet:', dep.address);
console.log('anchoring a run of checkpoints…');
await anchorRun(dep, ps, 'gasless');

// 2. A wallet that has never received anything.
const POOR_SEED = 'dead0000000000000000000000000000000000000000000000000000beef0001';
console.log('creating an unfunded wallet WITH the relay configured…');
const poor = await Midday.Client.create({
  seed: POOR_SEED,
  networkConfig: NET,
  privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
  feeRelay: { url: RELAY },
});

const c2 = await poor.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'gasless-poor', witnesses, initialPrivateState: ps,
});
// `join()` defaults its private state to `{}` (JoinOptions.initialPrivateState),
// and it is a separate provider from the one `loadContract` was given. Without
// this the witnesses return undefined and the call dies on a type error before
// it ever reaches the question this probe is asking.
const joined = await c2.join(dep.address, { initialPrivateState: ps });
console.log('unfunded wallet joined the contract');

console.log('unfunded wallet calling anchorCheckpoint, relay should pay the dust…');
const t0 = Date.now();
try {
  const r = await joined.actions.anchorCheckpoint(new Uint8Array(32), b32('gasless-rand-1'));
  console.log(JSON.stringify({ result: 'SPONSORED', txHash: r.txHash, ms: Date.now() - t0 }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ result: 'FAILED', ms: Date.now() - t0, error: firstLine(e) }, null, 2));
}
process.exit(0);
