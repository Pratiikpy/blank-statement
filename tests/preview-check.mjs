// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Has the preview wallet been funded in a way that lets it pay a fee?
//
// The distinction is the whole thing. NIGHT that arrives by transfer is
// unregistered and generates no DUST, so the wallet can hold plenty and still
// be unable to sign. NIGHT minted by the faucet arrives already registered for
// DUST generation, and DUST is what pays fees. So this reports both, and says
// which of the two happened.
//
//   node tests/preview-check.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, existsSync } from 'node:fs';

const NETWORK = process.env.NETWORK ?? 'preview';
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  proofServer: `https://proof-server.${NETWORK}.midnight.network`,
};

const file = `${PROFILE}/RECOVERY.txt`;
if (!existsSync(file)) { console.log('no recovery phrase saved at', file); process.exit(2); }
const phrase = readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
  .find((l) => l.split(/\s+/).length >= 12);
if (!phrase) { console.log('no phrase found'); process.exit(2); }
const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString('hex');

const address = Midday.Wallet.deriveAddress(seed, NETWORK);
console.log(`network : ${NETWORK}`);
console.log(`address : ${address}\n`);

console.log('opening the wallet (a public-network sync takes a few minutes)…');
const w = await Midday.Wallet.fromSeed(seed, NET);
const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

try {
  const b = await w.getBalance();
  const night = Object.values(b.unshielded ?? {}).reduce((a, x) => a + BigInt(x ?? 0n), 0n);
  const dust = BigInt(b.dust?.balance ?? 0n);
  const cap = BigInt(b.dust?.cap ?? 0n);

  console.log('\nunshielded :', show(b.unshielded));
  console.log('dust       :', show(b.dust));
  console.log('');
  console.log(`tNIGHT     : ${night}`);
  console.log(`DUST       : ${dust}   (cap ${cap})`);
  console.log('');

  if (dust > 0n) {
    console.log('CAN PAY FEES. The NIGHT here is registered for DUST generation,');
    console.log('which is what a faucet mint does and a transfer does not.');
    console.log('Public-network writes are now possible.');
    process.exit(0);
  }
  if (night > 0n) {
    console.log('HOLDS NIGHT BUT CANNOT PAY A FEE.');
    console.log('That means the NIGHT arrived by transfer, not by a faucet mint:');
    console.log('a transfer creates an unregistered UTXO, which generates no DUST,');
    console.log('and registering is itself a transaction needing the fee it lacks.');
    console.log('');
    console.log('A faucet mint straight to this address is what fixes it.');
    process.exit(3);
  }
  console.log('NOTHING HAS ARRIVED at this address yet.');
  process.exit(4);
} catch (e) {
  console.log('\nfailed:', String(e?.message ?? e).slice(0, 300));
  process.exit(1);
} finally {
  await w.close().catch(() => {});
}
