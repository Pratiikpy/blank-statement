// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What does the preview seed wallet hold? This is the wallet tests/faucet-request.mjs
// derives, so it is the one to check after a faucet request against that address.
//
// Endpoints are Midnight's public preview services, except the proof server,
// which stays local: a wallet only needs it to build transactions, not to read
// a balance.
import * as Midday from '@no-witness-labs/midday-sdk';
import { readFileSync, existsSync } from 'node:fs';

const SEED_FILE = process.env.SEED_FILE ?? `${process.env.HOME}/.cache/blank-statement/preview-seed.txt`;
if (!existsSync(SEED_FILE)) {
  console.log('no preview seed yet; run tests/faucet-request.mjs first');
  process.exit(2);
}
const seed = readFileSync(SEED_FILE, 'utf8').trim();

// Which public test network to look at. The address encodes its network, so
// checking the wrong one reports an empty wallet that is simply the wrong
// wallet.
const NETWORK = process.env.NETWORK ?? 'preview';
const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  proofServer: process.env.PROOF_SERVER ?? 'http://127.0.0.1:6300',
};

console.log('network:', NETWORK);
console.log('address:', Midday.Wallet.deriveAddress(seed, NETWORK));
console.log('syncing against preview, this takes a moment…\n');

const w = await Midday.Wallet.fromSeed(seed, NET);
try {
  const b = await w.getBalance();
  const night = '0'.repeat(64);
  const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  console.log('unshielded:', show(b.unshielded));
  console.log('shielded  :', show(b.shielded));
  console.log('dust      :', show(b.dust));

  const held = b.unshielded[night] ?? 0n;
  console.log('\ntNIGHT held:', held.toString());
  if (held > 0n) console.log('the faucet payment arrived');
  else console.log('nothing here yet');
} finally {
  await w.close();
}
process.exit(0);
