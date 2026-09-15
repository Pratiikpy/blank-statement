// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What the wallet situation on this network actually is, measured rather than
// assumed: what the genesis wallet holds, what a fresh wallet holds, where DUST
// comes from, and whether a second wallet can be funded at all.
//
// On a local `undeployed` chain there is no faucet service. The genesis seed
// 0000…0001 is the faucet.
import * as Midday from '@no-witness-labs/midday-sdk';
import { NET } from './probe.mjs';

const fmt = (n) => (typeof n === 'bigint' ? n.toString() : String(n));
const show = (label, b) => {
  console.log(`\n  ${label}`);
  console.log('    shielded  ', JSON.stringify(b.shielded, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  console.log('    unshielded', JSON.stringify(b.unshielded, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  console.log('    dust      ', fmt(b.dust.balance), 'of cap', fmt(b.dust.cap));
};

console.log('=== 1. The genesis wallet (this network\'s faucet) ===');
const genesis = await Midday.Wallet.fromSeed(Midday.Config.DEV_WALLET_SEED, NET);
console.log('  address        ', genesis.address.slice(0, 40) + '…');
console.log('  coinPublicKey  ', genesis.coinPublicKey.slice(0, 32) + '…');
const gb = await genesis.getBalance();
show('balance', gb);

console.log('\n=== 2. A brand new wallet, never funded ===');
const freshSeed = '00000000000000000000000000000000000000000000000000000000cafe0001';
const fresh = await Midday.Wallet.fromSeed(freshSeed, NET);
console.log('  address        ', fresh.address.slice(0, 40) + '…');
const fb = await fresh.getBalance();
show('balance', fb);
console.log('    -> can it pay a fee?', fb.dust.balance > 0n ? 'yes' : 'NO — this is why an unfunded wallet cannot transact');

console.log('\n=== 3. Is there any way to move value between wallets in this SDK? ===');
const ops = Object.keys(genesis).filter((k) => typeof genesis[k] === 'function');
console.log('  wallet methods:', ops.join(', '));
console.log('  shield/unshield move NIGHT between this wallet\'s own pools only.');
console.log('  transfer-to-another-address:', ops.some((o) => /send|transfer|pay/i.test(o)) ? 'present' : 'ABSENT from this SDK');

console.log('\n=== 4. DUST registration, which is what actually pays fees ===');
try {
  const r = await genesis.registerDust();
  console.log('  registerDust ->', JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const after = await genesis.getBalance();
  show('genesis balance after registering', after);
} catch (e) {
  console.log('  registerDust failed:', String(e?.message ?? e).split('\n')[0].slice(0, 200));
}

await genesis.close();
await fresh.close();
process.exit(0);
