// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Contention at scale: N statements racing on the same ledger slots. The
// question this answers is where the ceiling actually is, and the answer so far
// has been DUST rather than ledger contention.
import { deploy, anchorRun, freshState, b32, ZERO, firstLine } from './probe.mjs';

const N = Number(process.env.N ?? 10);
const ps = freshState();
const { dep } = await deploy('conc-scale', ps);
console.log('contract', dep.address, 'N =', N);

console.log('anchoring a run of checkpoints…');
await anchorRun(dep, ps, 'scale');

const exp = BigInt(Math.floor(Date.now() / 1000) + 7200);
for (let i = 0; i < N; i++) {
  await dep.actions.createRequest(b32('q' + i), b32('acme'), ZERO, 10000n, exp);
}
console.log(N, 'requests created; firing answers concurrently…');

const t0 = Date.now();
const settled = await Promise.allSettled(
  Array.from({ length: N }, (_, i) => dep.actions.answerRequest(b32('q' + i), b32('nx' + i))),
);
const elapsed = Date.now() - t0;
const ok = settled.filter((r) => r.status === 'fulfilled');
const bad = settled.filter((r) => r.status === 'rejected');
console.log(JSON.stringify({
  N,
  elapsed_ms: elapsed,
  succeeded: ok.length,
  failed: bad.length,
  txs: ok.map((r) => r.value.txHash),
  failures: bad.map((r) => firstLine(r.reason)),
}, null, 2));

const fin = await dep.ledgerState();
console.log('verdicts on chain:', fin.verdicts.size().toString());
process.exit(0);
