// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Open the seed wallet on a public test network, report what it holds, and
// register its NIGHT for DUST generation.
//
// This exists because Lace's own Generate tDUST fails silently: it reaches
// "generating zero-knowledge proof" and then leaves the DUST cap at zero, with
// nothing in the page console, no failed request, and its real work happening
// in a service worker that cannot be inspected. midday's registerDust() does
// the same operation and returns an error you can read.
//
//   NETWORK=preprod node tests/seed-dust.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { readFileSync, existsSync } from 'node:fs';

const SEED_FILE = process.env.SEED_FILE ?? `${process.env.HOME}/.cache/blank-statement/preview-seed.txt`;
const NETWORK = process.env.NETWORK ?? 'preprod';
if (!existsSync(SEED_FILE)) { console.log('no seed at', SEED_FILE); process.exit(2); }
const seed = readFileSync(SEED_FILE, 'utf8').trim();

const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  // The network's own prover is version-matched to it; the local one here is
  // built for the local chain.
  proofServer: process.env.PROOF_SERVER ?? `https://proof-server.${NETWORK}.midnight.network`,
};

const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const NIGHT = '0'.repeat(64);

console.log('network :', NETWORK);
console.log('address :', Midday.Wallet.deriveAddress(seed, NETWORK));
console.log('opening the wallet (the first sync against a public network is slow)\n');

const w = await Midday.Wallet.fromSeed(seed, NET);
try {
  const before = await w.getBalance();
  const night = before.unshielded[NIGHT] ?? 0n;
  console.log('holdings:');
  console.log('  tNIGHT    :', night.toString());
  console.log('  unshielded:', show(before.unshielded));
  console.log('  dust      :', show(before.dust));

  if (night === 0n) {
    console.log('\nnothing here yet — the faucet payment has not arrived at this address');
    process.exit(3);
  }

  console.log('\nregistering NIGHT for DUST generation…');
  const r = await w.registerDust();
  console.log('  returned:', show(r));

  for (const wait of [30000, 45000, 60000, 90000]) {
    await new Promise((res) => setTimeout(res, wait));
    const b = await w.getBalance();
    console.log(`  +${Math.round(wait / 1000)}s dust:`, show(b.dust));
    if ((b.dust?.cap ?? 0n) > 0n) { console.log('\nregistered — DUST is now generating'); break; }
  }
} catch (e) {
  // The whole point of this route: say what actually went wrong.
  console.log('\nFAILED:', String(e?.message ?? e).slice(0, 500));
  for (const key of ['cause', 'error', 'reason']) {
    const c = e?.[key];
    if (c) console.log(`${key}:`, String(c?.message ?? c).slice(0, 400));
  }
} finally {
  await w.close();
}
process.exit(0);
