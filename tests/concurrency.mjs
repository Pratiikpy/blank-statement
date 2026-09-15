// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Concurrency probe: do two statements racing on the same ledger slots both
// land? Both write to `verdicts`, `spent` and `requests` in the same block, so
// if the ledger serialised writers one of them would have to fail.
import { deploy, anchorRun, freshState, b32, ZERO, firstLine, inAnHour } from './probe.mjs';

const ps = freshState();
const { dep } = await deploy('conc-probe', ps);
console.log('contract', dep.address);

console.log('anchoring a run of checkpoints…');
await anchorRun(dep, ps, 'conc');

await dep.actions.createRequest(b32('rq-1'), b32('acme'), ZERO, 10000n, inAnHour());
await dep.actions.createRequest(b32('rq-2'), b32('acme'), ZERO, 10000n, inAnHour());
console.log('two open requests created');

console.log('firing two answers CONCURRENTLY (distinct nonces, same ledger slots)…');
const t0 = Date.now();
const settled = await Promise.allSettled([
  dep.actions.answerRequest(b32('rq-1'), b32('nonce-P')),
  dep.actions.answerRequest(b32('rq-2'), b32('nonce-Q')),
]);
const out = settled.map((r, i) => (r.status === 'fulfilled'
  ? { i, ok: true, tx: r.value.txHash }
  : { i, ok: false, err: firstLine(r.reason) }));
console.log(JSON.stringify(out, null, 2));
console.log('elapsed_ms', Date.now() - t0);

const fin = await dep.ledgerState();
console.log('verdicts on chain:', fin.verdicts.size().toString());
process.exit(0);
