// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Wait for preview to be able to afford a suite, then run it.
//
// DUST regenerates from registered NIGHT at roughly one and a half
// transactions an hour, so the two remaining suites are not blocked on a
// faucet, only on time. Sitting and watching that by hand is a waste of a
// person; this does the sitting.
//
// It refuses to start a suite it cannot pay for all the way through. Running
// dry halfway leaves a half-written contract on a public chain, which is worse
// than not starting, and the whole point of the estimates below is to never
// find that out the expensive way.
//
//   node tests/preview-watch.mjs
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as Midday from '@no-witness-labs/midday-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { readFileSync, existsSync } from 'node:fs';

const NETWORK = 'preview';
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const LOG = process.env.WATCH_LOG ?? '/tmp/preview-watch.log';
const BRIDGE = 'http://127.0.0.1:8790';
const NET = {
  networkId: NETWORK,
  indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${NETWORK}.midnight.network`,
  proofServer: `https://proof-server.${NETWORK}.midnight.network`,
};
const PER_TX = 400000000000000000n;

const say = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* logging must not stop the run */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const phrase = readFileSync(`${PROFILE}/RECOVERY.txt`, 'utf8').split('\n')
  .map((l) => l.trim()).find((l) => l.split(/\s+/).length >= 12);
const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString('hex');

/** Opening a wallet on a public network is minutes, so do it once and reuse. */
let wallet = null;
const affordable = async () => {
  if (!wallet) wallet = await Midday.Wallet.fromSeed(seed, NET);
  const d = BigInt((await wallet.getBalance()).dust?.balance ?? 0n);
  return { dust: d, tx: Number(d / PER_TX) };
};

const bridgeUp = async () => {
  try {
    const r = await fetch(`${BRIDGE}/api/state`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return j.network === NETWORK ? j : null;
  } catch { return null; }
};

const run = (script, env = {}) => new Promise((resolve) => {
  say(`running ${script}`);
  const p = spawn('node', [`tests/${script}`], {
    cwd: '/mnt/c/Users/prate/downloads/mid/blank-statement',
    env: { ...process.env, NETWORK, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  p.stdout.on('data', (b) => out.push(String(b)));
  p.stderr.on('data', (b) => out.push(String(b)));
  p.on('close', (code) => {
    const text = out.join('');
    const tail = text.split('\n').filter((l) => /PASS|FAIL|passed|failed|summary/i.test(l)).slice(-14);
    say(`${script} exited ${code}`);
    for (const l of tail) say('  ' + l.trim());
    resolve({ code, text });
  });
});

// Cost estimates. Deliberately generous: the penalty for over-estimating is
// waiting a little longer, and for under-estimating it is a half-written
// contract on a public chain.
const PLAN = [
  // Counted from the suite rather than guessed: about ten asks that succeed
  // plus three answers that settle. The refusals cost nothing, because they
  // fail while proving and never reach submission.
  { name: 'adversarial', script: 'adversarial.mjs', needs: 14 },
  { name: 'multiparty', script: 'multiparty.mjs', needs: 20, seedHolder: 'chidi' },
];

say(`watching ${NETWORK}; will run: ${PLAN.map((p) => `${p.name} (needs ${p.needs} tx)`).join(', ')}`);

for (const step of PLAN) {
  // Wait until it can be paid for end to end.
  for (;;) {
    const b = await affordable();
    say(`${step.name}: have ${b.tx} tx, needs ${step.needs}`);
    if (b.tx >= step.needs) break;
    await sleep(20 * 60 * 1000);
  }

  // multiparty needs a second holder anchored, which is eight of those
  // transactions and has to happen before the suite runs.
  if (step.seedHolder) {
    const state = await bridgeUp();
    const has = (state?.holders ?? []).some((h) => h.id === step.seedHolder);
    if (!has) {
      say(`${step.name}: needs holder ${step.seedHolder}; the bridge must be restarted with it`);
      say(`  BRIDGE_HOLDERS=alice,${step.seedHolder} bash preview-bridge.sh`);
      say('  stopping here rather than running a suite that would fail on a missing holder');
      break;
    }
  }

  if (!(await bridgeUp())) {
    say(`${step.name}: the bridge is not serving ${NETWORK}; start it first`);
    break;
  }
  const r = await run(step.script);
  say(`${step.name}: ${r.code === 0 ? 'PASSED' : 'FAILED (exit ' + r.code + ')'}`);
}

say('watch finished');
await wallet?.close().catch(() => {});
process.exit(0);
