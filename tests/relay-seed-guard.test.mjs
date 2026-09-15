// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The fee relay must not spend from a wallet the application also spends from.
//
// Sharing one means both build transactions against the same DUST inputs, and
// whichever submits second is spending inputs that are already gone. The node
// answers `1010: Invalid Transaction: Custom error: 196`, and the failure lands
// on the user's transaction rather than the relay's. It passes every test that
// writes one thing at a time, which is why it went unnoticed. See FINDING-03.
//
// This boots the built relay under each configuration and reads what it does.
// The guard is only worth having if it actually stops the process, so that is
// what gets checked rather than the presence of the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, '../fee-relay/dist/fee-relay-server.js');

/** Boot the relay, collect what it says, and stop it. */
const boot = (env, ms = 20000) => new Promise((resolve) => {
  const p = spawn('node', [RELAY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  p.stdout.on('data', (b) => out.push(String(b)));
  p.stderr.on('data', (b) => out.push(String(b)));
  const timer = setTimeout(() => p.kill('SIGKILL'), ms);
  p.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, text: out.join('') });
  });
  // A relay that starts correctly never exits, so stop it once it is listening.
  const stopWhenUp = setInterval(() => {
    if (out.join('').includes('Server running')) {
      clearInterval(stopWhenUp);
      p.kill('SIGKILL');
    }
  }, 250);
  p.on('close', () => clearInterval(stopWhenUp));
});

const ALICE = '0'.repeat(63) + '1';
const OWN = '00000000000000000000000000000000000000000000000000000000feeee1a1';

test('the relay refuses a seed the application holders use', async () => {
  const r = await boot({ NETWORK_ID: 'undeployed', FEE_RELAY_SEED: ALICE, FEE_RELAY_PORT: '3021' });
  assert.notEqual(r.code, 0, 'it has to refuse to start, not merely log');
  assert.match(r.text, /application holder wallets/);
  assert.match(r.text, /FINDING-03/, 'the message points at the write-up');
});

test('every application holder seed is covered, not just the first', async () => {
  for (const [n, seed] of [['2', '0'.repeat(63) + '2'], ['3', '0'.repeat(63) + '3']]) {
    const r = await boot({ NETWORK_ID: 'undeployed', FEE_RELAY_SEED: seed, FEE_RELAY_PORT: '302' + n });
    assert.notEqual(r.code, 0, `seed ...${n} should be refused`);
  }
});

test('a malformed seed is refused rather than silently truncated', async () => {
  const r = await boot({ NETWORK_ID: 'undeployed', FEE_RELAY_SEED: 'nothex', FEE_RELAY_PORT: '3024' });
  assert.notEqual(r.code, 0);
  assert.match(r.text, /64 hex characters/);
});

test('a public network will not start without its own seed', async () => {
  // There is no pre-funded wallet outside the local devnet, so falling back to
  // one there would be a silent no-op that fails on the first real write.
  const r = await boot({ NETWORK_ID: 'preview', FEE_RELAY_PORT: '3025' });
  assert.notEqual(r.code, 0);
  assert.match(r.text, /required on preview/);
});

test('a seed of its own is accepted and the relay serves', async () => {
  const r = await boot({ NETWORK_ID: 'undeployed', FEE_RELAY_SEED: OWN, FEE_RELAY_PORT: '3026' });
  assert.match(r.text, /Server running on port 3026/);
  assert.doesNotMatch(r.text, /holder wallets/);
});

test('the local fallback still works, and says what it costs', async () => {
  // Refusing here would break every existing local setup. It starts, and the
  // warning is the part that has to be there.
  const r = await boot({ NETWORK_ID: 'undeployed', FEE_RELAY_PORT: '3027' });
  assert.match(r.text, /Server running on port 3027/, 'the local chain must still work with no seed');
  assert.match(r.text, /falling back to the devnet genesis wallet/);
  assert.match(r.text, /can collide/);
});

test('the built relay exists to test at all', () => {
  assert.ok(existsSync(RELAY), 'run: cd fee-relay && ./node_modules/.bin/tsc');
});
