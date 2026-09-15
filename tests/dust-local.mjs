// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Does registerDust() work at all, on a chain we control?
//
// On preview it fails with "1010: Invalid Transaction: Custom error: 192",
// which is the node rejecting the extrinsic before it is even included. That
// error alone does not say whether the SDK call is wrong, the wallet is
// missing something, or preview specifically refuses it. Running the identical
// call against the local chain separates those: the local chain is ours, its
// genesis funds these seeds, and nothing about it is rate limited or
// gated.
//
// A pass here means the call is right and preview is the problem. A failure
// with the same 192 means the call itself is wrong, which is a much better
// thing to know than a silent wallet.
//
//   node tests/dust-local.mjs
import * as Midday from '@no-witness-labs/midday-sdk';

const NET = {
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8188/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8188/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
};
// The bridge's first holder. Genesis funds it on the local chain.
const SEED = process.env.SEED ?? '0'.repeat(63) + '1';
const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

console.log('opening the wallet on the local chain');
const w = await Midday.Wallet.fromSeed(SEED, NET);
try {
  console.log('address:', w.address);
  const before = await w.getBalance();
  console.log('unshielded:', show(before.unshielded));
  console.log('shielded  :', show(before.shielded));
  console.log('dust      :', show(before.dust));

  const night = Object.values(before.unshielded ?? {}).reduce((a, b) => a + BigInt(b ?? 0n), 0n);
  if (night === 0n) {
    console.log('\nthis wallet holds no unshielded NIGHT on the local chain,');
    console.log('so there is nothing to register. Not a verdict on the call itself.');
    await w.close();
    process.exit(2);
  }

  console.log('\ncalling registerDust()');
  const r = await w.registerDust();
  console.log('result:', show(r));

  for (const wait of [15000, 30000, 45000]) {
    await new Promise((res) => setTimeout(res, wait));
    const b = await w.getBalance();
    console.log(`+${Math.round(wait / 1000)}s dust:`, show(b.dust));
    if (BigInt(b.dust?.cap ?? 0n) > 0n) {
      console.log('\nregisterDust works. The call is right, and preview is what refuses it.');
      await w.close();
      process.exit(0);
    }
  }
  console.log('\nsubmitted but the cap never moved.');
} catch (e) {
  const msg = String(e?.message ?? e);
  console.log('\nfailed:', msg.slice(0, 400));
  const cause = e?.cause ?? e?.error;
  if (cause) console.log('cause :', String(cause?.message ?? cause).slice(0, 300));
  // The same code on both chains points at the call; a different one points at
  // the network.
  if (/Custom error: 192/.test(msg)) {
    console.log('\nsame 192 as preview: the call itself is being rejected, not the network.');
  }
} finally {
  await w.close().catch(() => {});
}
process.exit(0);
