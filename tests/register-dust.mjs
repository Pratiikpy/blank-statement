// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Register the wallet's NIGHT for DUST generation from Node, using the same
// keys Lace holds.
//
// Lace's own Generate tDUST flow runs to "Processing transaction, generating
// zero-knowledge proof" and then the DUST cap stays at zero, so the transaction
// never lands. Midnight's own guide documents this same operation through the
// wallet SDK ("Registering NIGHT for DUST generation with the wallet SDK"), and
// midday exposes it as ConnectedWallet.registerDust().
//
// The wallet is the same one either way: Lace derives its keys from the
// recovery phrase through BIP39's PBKDF2, which was verified earlier by
// restoring a known phrase and comparing addresses. So the phrase saved beside
// the profile rebuilds Lace's wallet exactly, and the address check below
// refuses to go further unless it does.
import * as Midday from '@no-witness-labs/midday-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, existsSync } from 'node:fs';

const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const NETWORK = process.env.NETWORK ?? 'preview';
const EXPECT = process.env.EXPECT_ADDRESS ??
  'mn_addr_preview1htsqvckca45m6lu774vqaejm5zxk9myfzw2grsfpdmsw47npfygsnw43ec';

const file = `${PROFILE}/RECOVERY.txt`;
if (!existsSync(file)) {
  console.log('no recovery phrase saved at', file);
  process.exit(2);
}
// The file is "local test fixture only" then a blank line then the phrase.
const phrase = readFileSync(file, 'utf8')
  .split('\n').map((l) => l.trim())
  .find((l) => l.split(/\s+/).length >= 12);
if (!phrase) { console.log('could not find a phrase in', file); process.exit(2); }
console.log('phrase words:', phrase.split(/\s+/).length);

const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString('hex');
const address = Midday.Wallet.deriveAddress(seed, NETWORK);
console.log('derived  :', address);
console.log('expected :', EXPECT);
if (address !== EXPECT) {
  console.log('\nthese are different wallets; refusing to act on the wrong one');
  process.exit(3);
}
console.log('same wallet as Lace holds\n');

const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  // Preview's own prover is version-matched to preview; the local one here is
  // built for the local chain.
  proofServer: process.env.PROOF_SERVER ?? `https://proof-server.${NETWORK}.midnight.network`,
};

console.log('opening the wallet against', NETWORK, '(the sync takes a while)');
const w = await Midday.Wallet.fromSeed(seed, NET);
try {
  const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const before = await w.getBalance();
  console.log('before:');
  console.log('  unshielded:', show(before.unshielded));
  console.log('  dust      :', show(before.dust));

  console.log('\nregistering NIGHT for DUST generation…');
  const r = await w.registerDust();
  console.log('  result:', show(r));

  // Registration is a transaction; give it a couple of blocks.
  for (const wait of [30000, 45000, 60000]) {
    await new Promise((res) => setTimeout(res, wait));
    const b = await w.getBalance();
    console.log(`  +${Math.round(wait / 1000)}s dust:`, show(b.dust));
    if ((b.dust?.cap ?? 0n) > 0n) { console.log('\nDUST generation is registered'); break; }
  }
} catch (e) {
  console.log('\nfailed:', String(e?.message ?? e).slice(0, 400));
  const cause = e?.cause ?? e?.error;
  if (cause) console.log('cause :', String(cause?.message ?? cause).slice(0, 300));
} finally {
  await w.close();
}
process.exit(0);
