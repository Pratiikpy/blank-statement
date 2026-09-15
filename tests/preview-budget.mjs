// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// How much can this wallet actually afford on preview, and how fast does it
// refill?
//
// Fees on a public network are real, and the whole product suite is dozens of
// transactions: seeding four holders alone is 32 anchors. Running it and
// finding out halfway through that the wallet is empty would leave the chain
// ahead of the tests, so measure first.
//
// DUST regenerates from registered NIGHT up to a cap, so the question is not
// only the balance now but the rate. Two readings a few minutes apart give
// both.
//
//   node tests/preview-budget.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, existsSync } from 'node:fs';

const NETWORK = process.env.NETWORK ?? 'preview';
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const GAP_MS = Number(process.env.GAP_MS ?? 240000);
const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  proofServer: `https://proof-server.${NETWORK}.midnight.network`,
};

// Measured on this network: an anchor and a createRequest together moved the
// balance by 790710260000000003, so a transaction costs about 4e17.
const PER_TX = BigInt(process.env.PER_TX ?? '400000000000000000');

const file = `${PROFILE}/RECOVERY.txt`;
if (!existsSync(file)) { console.log('no recovery phrase at', file); process.exit(2); }
const phrase = readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
  .find((l) => l.split(/\s+/).length >= 12);
const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString('hex');

const w = await Midday.Wallet.fromSeed(seed, NET);
const dustNow = async () => BigInt((await w.getBalance()).dust?.balance ?? 0n);

try {
  console.log(`network: ${NETWORK}`);
  console.log('reading the balance (the sync takes a few minutes)…');
  const a = await dustNow();
  const tA = Date.now();
  console.log(`\n  now        : ${a}`);
  console.log(`  affords    : about ${a / PER_TX} transactions at ~${PER_TX} each`);

  console.log(`\nwaiting ${Math.round(GAP_MS / 60000)} minutes to measure the refill rate…`);
  await new Promise((r) => setTimeout(r, GAP_MS));
  const b = await dustNow();
  const mins = (Date.now() - tA) / 60000;
  const gained = b - a;
  console.log(`  after ${mins.toFixed(1)}m : ${b}`);
  console.log(`  gained     : ${gained}`);

  if (gained > 0n) {
    const perMin = gained / BigInt(Math.max(1, Math.round(mins)));
    const txPerHour = (perMin * 60n) / PER_TX;
    console.log(`  refill     : about ${perMin} per minute, roughly ${txPerHour} transactions an hour`);
  } else {
    console.log('  refill     : none measured in this window');
  }

  console.log('\nwhat the suites cost, roughly:');
  const costs = [
    ['seed one holder (8 anchors)', 8n],
    ['seed all four holders', 32n],
    ['post an ask', 1n],
    ['answer an ask', 1n],
    ['one journey run', 2n],
    ['the multiparty suite', 8n],
    ['the adversarial suite', 24n],
  ];
  for (const [what, n] of costs) {
    const need = n * PER_TX;
    console.log(`  ${what.padEnd(30)} ~${n} tx  ${need <= b ? 'affordable now' : 'needs a refill'}`);
  }
} finally {
  await w.close().catch(() => {});
}
process.exit(0);
