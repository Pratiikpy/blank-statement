// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Does this node's `dev` preset fund more than one wallet? If it funds several
// well-known seeds then genuine multi-wallet testing is possible with no faucet
// and no browser extension. Measured, because guessing at genesis allocation is
// how people end up asserting against an empty account.
import * as Midday from '@no-witness-labs/midday-sdk';
import { NET } from './probe.mjs';

const seed = (n) => n.toString(16).padStart(64, '0');
const candidates = [1, 2, 3, 4, 5, 10];

console.log('seed'.padEnd(6), 'dust'.padEnd(26), 'unshielded NIGHT'.padEnd(20), 'address');
for (const n of candidates) {
  const s = seed(n);
  let w;
  try {
    w = await Midday.Wallet.fromSeed(s, NET);
    const b = await w.getBalance();
    const night = b.unshielded['0'.repeat(64)] ?? 0n;
    const shielded = b.shielded['0'.repeat(64)] ?? 0n;
    const funded = b.dust.balance > 0n || night > 0n || shielded > 0n;
    console.log(
      String(n).padEnd(6),
      String(b.dust.balance).padEnd(26),
      String(night).padEnd(20),
      w.address.slice(0, 28) + '…',
      funded ? '  <-- FUNDED' : '',
    );
  } catch (e) {
    console.log(String(n).padEnd(6), 'error:', String(e?.message ?? e).split('\n')[0].slice(0, 80));
  } finally {
    if (w) await w.close();
  }
}
process.exit(0);
