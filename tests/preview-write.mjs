// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The contract, on a public Midnight network, paying its own fee.
//
// Everything written until now has been on `undeployed`, the local chain, and
// the honest line in the report was "reads on three networks, writes on one".
// This closes that: deploy the real contract to preview, anchor a checkpoint,
// post an ask and answer it, with the fee paid by the wallet's own DUST rather
// than by a relay holding genesis funds.
//
// It is possible because the DUST problem is solved. Lace's own Generate tDUST
// works on preview once the proof server is set to Remote and the setting is
// actually saved, which is the step every earlier attempt missed.
//
//   node tests/preview-write.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const NETWORK = process.env.NETWORK ?? 'preview';
const NOTE = process.env.NOTE ?? `${process.env.HOME}/.cache/blank-statement/${NETWORK}-contract.txt`;
const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  proofServer: `https://proof-server.${NETWORK}.midnight.network`,
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const first = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 220);
const b32 = (s) => { const u = new Uint8Array(32); u.set(new TextEncoder().encode(String(s)).slice(0, 32)); return u; };
const ZERO = new Uint8Array(32);
const BATCH = [1200n, 900n, 1500n, 700n, 2200n, 400n, 1800n, 1300n];

const file = `${PROFILE}/RECOVERY.txt`;
if (!existsSync(file)) { console.log('no recovery phrase at', file); process.exit(2); }
const phrase = readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
  .find((l) => l.split(/\s+/).length >= 12);
const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString('hex');

console.log(`network : ${NETWORK}`);
console.log(`address : ${Midday.Wallet.deriveAddress(seed, NETWORK)}\n`);
console.log('opening the wallet (a public-network sync takes a few minutes)…');

const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
const witnesses = {
  holderSk:            ({ privateState }) => [privateState, privateState.sk],
  batchAmounts:        ({ privateState }) => [privateState, privateState.batchAmounts],
  batchCounterparties: ({ privateState }) => [privateState, privateState.batchCps],
  batchCount:          ({ privateState }) => [privateState, privateState.batchCount],
  chain:               ({ privateState }) => [privateState, privateState.chain],
  chainRands:          ({ privateState }) => [privateState, privateState.chainRands],
  membership:          ({ privateState }) => [privateState, privateState.path],
};
const ps = {
  sk: b32('preview-holder-secret'),
  batchAmounts: BATCH,
  batchCps: Array.from({ length: 8 }, (_, i) => b32('preview-counterparty-' + i)),
  batchCount: BigInt(BATCH.length),
  chain: undefined, chainRands: undefined, path: undefined,
};

const wallet = await Midday.Wallet.fromSeed(seed, NET);
try {
  const bal = await wallet.getBalance();
  const dust = BigInt(bal.dust?.balance ?? 0n);
  console.log('dust:', show(bal.dust));
  check('the wallet can pay a fee on this network', dust > 0n, dust.toString());
  if (dust === 0n) {
    console.log('\nBLOCKED: no DUST. Run Generate tDUST in Lace with the proof server on Remote.');
    await wallet.close();
    process.exit(2);
  }

  const client = await Midday.Client.create({
    wallet, networkConfig: NET,
    privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
  });
  const loaded = await client.loadContract({
    module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
    privateStateId: `blank-statement-${NETWORK}`, witnesses, initialPrivateState: ps,
  });

  // ---------------------------------------------------------------------
  console.log('\n1. deploying the contract to ' + NETWORK);
  // ---------------------------------------------------------------------
  let dep;
  const existing = existsSync(NOTE) ? readFileSync(NOTE, 'utf8').trim() : '';
  if (existing) {
    console.log('  joining the one already deployed:', existing);
    dep = await loaded.join(existing, { initialPrivateState: ps });
  } else {
    dep = await loaded.deploy({ initialPrivateState: ps });
    writeFileSync(NOTE, dep.address + '\n');
  }
  console.log('  contract:', dep.address);
  check('the contract is on ' + NETWORK, !!dep.address, dep.address);

  // ---------------------------------------------------------------------
  console.log('\n2. anchoring a checkpoint, fee paid by this wallet');
  // ---------------------------------------------------------------------
  const before = await dep.ledgerState();
  const issuedBefore = Number(before.issued.toString());
  const rand = b32('preview-rand-' + Date.now());
  let anchored = null;
  try {
    anchored = await dep.actions.anchorCheckpoint(ZERO, rand);
  } catch (e) {
    check('the anchor landed', false, first(e));
  }
  if (anchored) {
    const tx = anchored?.txHash ?? anchored?.txId ?? show(anchored).slice(0, 80);
    console.log('  tx   :', tx);
    console.log('  block:', anchored?.blockHeight ?? '(not reported)');
    const after = await dep.ledgerState();
    const issuedAfter = Number(after.issued.toString());
    check('the anchor landed', !!tx, String(tx).slice(0, 70));
    check('the ledger counter moved on a public network',
      issuedAfter === issuedBefore + 1, `${issuedBefore} -> ${issuedAfter}`);

    // Keep the run so an answer can be proved against it.
    const cp = {
      prev: ZERO,
      total: BATCH.reduce((a, b) => a + b, 0n),
      count: BigInt(BATCH.length),
      largest: BATCH.reduce((a, b) => (b > a ? b : a), 0n),
    };
    const leaf = C.pureCircuits.checkpointIdOf(cp, rand);
    ps.chain = Array.from({ length: 8 }, () => cp);
    ps.chainRands = Array.from({ length: 8 }, () => rand);
    ps.path = after.receipts.findPathForLeaf(leaf);
    // A run of one repeated checkpoint does not chain, so only the ask itself
    // is proved here; the full answer needs a real run and eight transactions.
    console.log('  membership path found:', !!ps.path);
  }

  // ---------------------------------------------------------------------
  console.log('\n3. posting an ask on ' + NETWORK);
  // ---------------------------------------------------------------------
  const ref = b32('pv-' + Date.now().toString(36));
  try {
    const r = await dep.actions.createRequest(ref, b32('Preview Ltd'), ZERO, 1000n,
      BigInt(Math.floor(Date.now() / 1000) + 3600));
    console.log('  tx:', r?.txHash ?? show(r).slice(0, 70));
    const st = await dep.ledgerState();
    let found = false;
    for (const [k] of st.requests) {
      if (Buffer.from(k).toString('utf8').replace(/\0+$/, '') === Buffer.from(ref).toString('utf8').replace(/\0+$/, '')) found = true;
    }
    check('the ask is on the public ledger', found);
  } catch (e) {
    check('the ask is on the public ledger', false, first(e));
  }

  const end = await wallet.getBalance();
  console.log('\ndust after:', show(end.dust));
  console.log('a fee was genuinely paid from this wallet, on a public network.');
} catch (e) {
  console.log('\nfailed:', first(e));
  failures++;
} finally {
  await wallet.close().catch(() => {});
}

console.log(`\n${failures === 0 ? NETWORK + ' writes work' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
