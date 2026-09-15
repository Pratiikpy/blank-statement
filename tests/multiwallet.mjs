// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The scaling question, asked properly.
//
// A single wallet firing ten concurrent statements fails five of them on DUST.
// That measurement could not distinguish two very different causes: a per-wallet
// fee-resource limit, or contention on the shared ledger slots. This settles it,
// because this node's `dev` preset funds three independent wallets (seeds
// 0001/0002/0003), each with its own DUST pool and its own key.
//
// Three wallets write to the SAME contract, the same MerkleTree and the same
// Counter, at the same time. If the ledger is the bottleneck they collide. If
// DUST is the bottleneck, three pools should carry roughly three times the load.
//
//   N=<per-wallet concurrency>   default 5
import * as Midday from '@no-witness-labs/midday-sdk';
import { C, CONTRACT_DIR, NET, witnesses, freshState, b32, ZERO, firstLine } from './probe.mjs';

const PER_WALLET = Number(process.env.N ?? 5);
const SEEDS = [1, 2, 3].map((n) => n.toString(16).padStart(64, '0'));

const money = (b) => (b.dust.balance / 10n ** 18n).toString() + 'e18';

// One wallet deploys; the others join the same address, so every write lands on
// the same ledger slots.
console.log(`three wallets, ${PER_WALLET} concurrent anchors each, one shared contract\n`);

const clients = [];
for (const [i, seed] of SEEDS.entries()) {
  const wallet = await Midday.Wallet.fromSeed(seed, NET);
  const bal = await wallet.getBalance();
  console.log(`  wallet ${i + 1}  ${wallet.address.slice(0, 30)}…  dust ${money(bal)}`);
  const client = await Midday.Client.create({
    wallet,
    networkConfig: NET,
    privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
  });
  clients.push({ i: i + 1, wallet, client, ps: freshState(b32('holder-' + i)) });
}

console.log('\ndeploying the shared contract from wallet 1...');
const first = clients[0];
const loaded0 = await first.client.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'mw-0', witnesses, initialPrivateState: first.ps,
});
const dep0 = await loaded0.deploy({ initialPrivateState: first.ps });
first.dep = dep0;
console.log('  contract', dep0.address.slice(0, 32) + '…');

for (const c of clients.slice(1)) {
  const loaded = await c.client.loadContract({
    module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
    privateStateId: 'mw-' + c.i, witnesses, initialPrivateState: c.ps,
  });
  c.dep = await loaded.join(dep0.address, { initialPrivateState: c.ps });
  console.log(`  wallet ${c.i} joined`);
}

const before = await dep0.ledgerState();
console.log('\nissued before:', before.issued.toString());

console.log(`\nfiring ${PER_WALLET * clients.length} anchors concurrently across ${clients.length} wallets...`);
const t0 = Date.now();
const results = await Promise.all(clients.map(async (c) => {
  const settled = await Promise.allSettled(
    Array.from({ length: PER_WALLET }, (_, k) =>
      c.dep.actions.anchorCheckpoint(ZERO, b32(`mw-${c.i}-${k}-${Date.now()}`))),
  );
  return {
    wallet: c.i,
    ok: settled.filter((r) => r.status === 'fulfilled').length,
    failed: settled.filter((r) => r.status === 'rejected').length,
    reasons: settled.filter((r) => r.status === 'rejected').map((r) => firstLine(r.reason)),
  };
}));
const elapsed = Date.now() - t0;

const after = await dep0.ledgerState();
const landed = Number(after.issued) - Number(before.issued);

console.log('\n--- per wallet ---');
for (const r of results) {
  console.log(`  wallet ${r.wallet}: ${r.ok} landed, ${r.failed} failed`);
  const dust = r.reasons.filter((x) => /InsufficientFunds|dust/i.test(x)).length;
  const other = r.reasons.filter((x) => !/InsufficientFunds|dust/i.test(x));
  if (r.failed) console.log(`     ${dust} on dust, ${other.length} other`);
  for (const o of other.slice(0, 2)) console.log('     other:', o.slice(0, 120));
}

const totalOk = results.reduce((a, r) => a + r.ok, 0);
console.log('\n--- verdict ---');
console.log(`  attempted            ${PER_WALLET * clients.length}`);
console.log(`  reported success     ${totalOk}`);
console.log(`  issued grew by       ${landed}   (the ledger's own count)`);
console.log(`  elapsed              ${(elapsed / 1000).toFixed(1)}s`);
console.log(`  ledger conflicts     ${results.flatMap((r) => r.reasons).filter((x) => /conflict|contention/i.test(x)).length}`);

for (const c of clients) await c.wallet.close();
process.exit(0);
