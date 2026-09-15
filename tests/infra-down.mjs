// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// What the product does when a piece of Midnight is not there.
//
// Everything else in this repo tests a healthy stack. A real deployment is not
// always healthy: the proof server falls over, the node stops answering, the
// indexer lags. The question is never whether that happens, it is whether the
// product says so or leaves someone staring at a spinner believing their
// statement is on its way.
//
// Each case stops one service, drives the product, and reads what it says. The
// service is put back afterwards, whatever happens, because leaving a chain
// half-dead would poison every suite after this one.
//
//   node tests/infra-down.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
const PROOF = process.env.PROOF ?? 'http://127.0.0.1:6300';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};
const docker = (...args) => run('docker', args).then((r) => r.stdout.trim()).catch((e) => 'ERR ' + e.message);

const alive = async (url) => {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
};

const ref = () => 'infra-' + Math.random().toString(36).slice(2, 8);
const post = async (path, body) => {
  try {
    const r = await fetch(`${BRIDGE}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: j };
  } catch (e) {
    return { status: 0, body: { error: String(e.message) } };
  }
};

console.log('checking everything is healthy before breaking anything\n');
check('I0a', 'the proof server is up', await alive(`${PROOF}/health`));
check('I0b', 'the bridge is up', await alive(`${BRIDGE}/api/state`));
if (failures) { console.log('\nBLOCKED: the stack is not healthy to begin with'); process.exit(2); }

// ===========================================================================
console.log('\n1. the proof server goes away mid-flight');
// ===========================================================================
{
  console.log('  stopping midnight-proof-server');
  await docker('stop', 'midnight-proof-server');
  await sleep(3000);
  check('I1a', 'the proof server really is down', !(await alive(`${PROOF}/health`)));

  // A write needs a proof. With no prover it must fail, and it must fail
  // saying something, rather than hanging until someone gives up.
  const t0 = Date.now();
  const r = await post('/api/request', {
    id: ref(), verifier: 'Infra Ltd', threshold: '100', ttlSeconds: 3600,
  });
  const took = Math.round((Date.now() - t0) / 1000);
  console.log(`  the ask attempt took ${took}s and answered ${r.status}`);
  const said = JSON.stringify(r.body ?? {});
  check('I1b', 'a write without a prover fails rather than hanging forever',
    r.status !== 200, `status ${r.status} after ${took}s`);
  check('I1c', 'and it says something rather than nothing',
    said.length > 2 && said !== '{}', said.slice(0, 140));
  // The honest bar: a user must not be told it worked.
  check('I1d', 'it never reports success', !(r.status === 200), `status ${r.status}`);

  // Reads should keep working: they need the indexer, not the prover.
  const state = await fetch(`${BRIDGE}/api/state`).then((x) => x.json()).catch(() => null);
  check('I1e', 'reading the ledger still works with the prover down', !!state?.address,
    state?.address?.slice(0, 12) ?? 'no state');

  console.log('  starting midnight-proof-server again');
  await docker('start', 'midnight-proof-server');
  for (let i = 0; i < 30; i++) {
    if (await alive(`${PROOF}/health`)) break;
    await sleep(2000);
  }
  check('I1f', 'the proof server comes back', await alive(`${PROOF}/health`));
}

// ===========================================================================
console.log('\n2. and the product works again afterwards');
// ===========================================================================
{
  // Recovery is the half that usually breaks: a process that cached a dead
  // connection keeps failing after the service returns.
  await sleep(4000);
  const id = ref();
  const r = await post('/api/request', {
    id, verifier: 'Infra Ltd', threshold: '100', ttlSeconds: 3600,
  });
  check('I2a', 'an ask can be posted once the prover is back', r.status === 200,
    `status ${r.status} ${JSON.stringify(r.body ?? {}).slice(0, 90)}`);

  const state = await fetch(`${BRIDGE}/api/state`).then((x) => x.json()).catch(() => null);
  check('I2b', 'and it reached the chain',
    (state?.requests ?? []).some((q) => q.id === id), id);
}

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
// Whatever happened, the stack must be left healthy.
if (!(await alive(`${PROOF}/health`))) {
  console.log('\nputting the proof server back');
  await docker('start', 'midnight-proof-server');
}
process.exit(failures === 0 ? 0 : 1);
