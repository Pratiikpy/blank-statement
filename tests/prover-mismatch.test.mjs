// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The wallet's proof server has to belong to the network it is on.
//
// Lace keeps one proof server setting across every network, so the Local choice
// the local chain needs follows a person onto preview and points proving at
// their own machine. With that server stopped a write does not fail, it hangs —
// 313 seconds, measured — and nothing says which prover is in use.
//
// The app cannot change a wallet setting, so it says what it was handed. These
// are the cases that sentence has to get right, including the ones where there
// is nothing to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proverMismatch } from '../app/src/wallet.js';

const LOCAL = 'http://localhost:6300';
const REMOTE = 'https://proof-server.preview.midnight.network';

test('a public network proving on this machine is called out', () => {
  const m = proverMismatch('preview', LOCAL);
  assert.ok(m, 'expected a warning');
  assert.match(m, /preview/);
  assert.match(m, /this machine/);
  assert.match(m, /hang/, 'the warning has to say what goes wrong, not just that it is wrong');
  assert.match(m, /Remote/, 'and what to do about it');
});

test('127.0.0.1 and ::1 count as this machine too', () => {
  for (const uri of ['http://127.0.0.1:6300', 'http://[::1]:6300', 'HTTP://LOCALHOST:6300']) {
    assert.ok(proverMismatch('preview', uri), `${uri} should be caught`);
  }
});

test('a public network proving on its own server says nothing', () => {
  assert.equal(proverMismatch('preview', REMOTE), null);
  assert.equal(proverMismatch('preprod', 'https://proof-server.preprod.midnight.network'), null);
});

test('the local chain wants the local prover', () => {
  assert.equal(proverMismatch('undeployed', LOCAL), null);
  const m = proverMismatch('undeployed', REMOTE);
  assert.ok(m, 'a remote prover cannot see a local chain');
  assert.match(m, /Local/);
});

test('nothing to say when the wallet reports nothing', () => {
  // getConfiguration can fail, and a missing field must not become a warning
  // about a prover nobody has named.
  assert.equal(proverMismatch(null, LOCAL), null);
  assert.equal(proverMismatch('preview', null), null);
  assert.equal(proverMismatch('preview', undefined), null);
  assert.equal(proverMismatch(undefined, undefined), null);
});

test('a host merely containing "localhost" is not this machine', () => {
  // localhost.example.com is a real remote host; a substring match would warn
  // about a correctly configured wallet.
  assert.equal(proverMismatch('preview', 'https://localhost.example.com/prove'), null);
  assert.equal(proverMismatch('preview', 'https://notlocalhost:6300'), null);
});
