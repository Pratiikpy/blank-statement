// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Send unshielded NIGHT from one of the dev chain's pre-funded seeds to any
// address, so a browser wallet can hold something on this chain.
//
//   RECIPIENT=mn_addr_undeployed1... node tests/fund-address.mjs
//
// midday's ConnectedWallet has no transfer, but it does expose the wallet
// context, and the facade underneath takes the same initSwap → signRecipe →
// finalizeRecipe → submitTransaction path that the SDK's own shield() uses.
// Same-pool in and out makes it a transfer rather than a conversion.
//
// The dev preset funds seeds 0x…01, 0x…02 and 0x…03 with 250T NIGHT each and
// leaves them DUST-registered, so they can pay their own fees.
import * as Midday from '@no-witness-labs/midday-sdk';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { Effect } from 'effect';
import { NET } from './probe.mjs';

const RECIPIENT = process.env.RECIPIENT;
const SEED = process.env.SEED ?? '0'.repeat(63) + '1';
// 1000 NIGHT in the smallest unit. Enough to register for DUST and still leave
// a working balance; the dev wallets hold 250,000x this.
const AMOUNT = BigInt(process.env.AMOUNT ?? 1_000_000_000n);

if (!RECIPIENT) {
  console.error('set RECIPIENT to an mn_addr_undeployed1… address');
  process.exit(2);
}

const run = (e) => Effect.runPromise(e);
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

console.log('funding   :', RECIPIENT.slice(0, 44) + '…');
console.log('from seed :', SEED.slice(0, 6) + '…' + SEED.slice(-4));
console.log('amount    :', AMOUNT.toString());

const ctx = await run(Midday.Wallet.effect.init(SEED, NET));
console.log('\nwaiting for the source wallet to sync');
await run(Midday.Wallet.effect.waitForSync(ctx));

const tokenType = ledger.nativeToken().raw;
const balanceOf = async (label) => {
  const w = await Midday.Wallet.fromSeed(SEED, NET);
  try {
    const b = await w.getBalance();
    console.log(`  ${label}: unshielded ${b.unshielded[tokenType] ?? 0n}, dust ${b.dust.balance}`);
  } finally { await w.close(); }
};

// Decode once: a bech32 string is not what the ledger wants as a recipient.
const receiverAddress = UnshieldedAddress.codec.decode(
  ctx.networkId, MidnightBech32m.parse(RECIPIENT));

console.log('\nbuilding the transfer');
const ttl = new Date(Date.now() + 15 * 60 * 1000);
const recipe = await ctx.wallet.initSwap(
  { unshielded: { [tokenType]: AMOUNT } },
  [{ type: 'unshielded', outputs: [{ type: tokenType, receiverAddress, amount: AMOUNT }] }],
  { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
  { ttl, payFees: true },
);
console.log('  recipe built');

const signed = await ctx.wallet.signRecipe(recipe,
  (payload) => ctx.unshieldedKeystore.signData(payload));
console.log('  signed');

const finalized = await ctx.wallet.finalizeRecipe(signed);
console.log('  finalized');

const txId = await ctx.wallet.submitTransaction(finalized);
console.log('\nsubmitted:', show(txId));

await run(Midday.Wallet.effect.close(ctx));
console.log('\nsource wallet after (allow a block or two):');
await balanceOf('source');
process.exit(0);
