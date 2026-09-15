// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Request preview tNIGHT using Midnight's own testkit faucet client.
//
// `@midnight-ntwrk/testkit-js` ships a FaucetClient whose requestTokens() posts
// to https://faucet.<network>.midnight.network/api/drips with a fixed
// `X-Captcha-Token: XXXX.DUMMY.TOKEN.XXXX` and an optional `x-turnstile-token`
// from TURNSTILE_HEADER. That is the vendor's own automation path for test
// networks, published in their public package, and this uses it as written
// rather than reimplementing anything.
//
// The web form is rate limited per address, and every submission — accepted or
// not — pushes the window forward, so this defaults to a freshly derived
// address rather than one already refused.
import { FaucetClient } from '@midnight-ntwrk/testkit-js';
import * as Midday from '@no-witness-labs/midday-sdk';
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const NETWORK = process.env.NETWORK ?? 'preview';
const FAUCET = process.env.FAUCET ?? `https://faucet.${NETWORK}.midnight.network/api/drips`;
const SEED_FILE = process.env.SEED_FILE ?? `${process.env.HOME}/.cache/blank-statement/preview-seed.txt`;

// The testkit takes a pino logger; a console shim keeps this dependency-free.
const logger = {
  info: (m) => console.log('  ' + m),
  warn: (m) => console.log('  warn: ' + m),
  error: (m) => console.log('  error: ' + m),
  debug: () => {},
  child: () => logger,
};

// One seed, kept, or every run funds a new wallet and strands the last one.
let seed;
if (existsSync(SEED_FILE)) {
  seed = readFileSync(SEED_FILE, 'utf8').trim();
  console.log('reusing the saved preview seed');
} else {
  seed = randomBytes(32).toString('hex');
  writeFileSync(SEED_FILE, seed + '\n');
  console.log('generated a new preview seed, saved beside the wallet profiles');
}

const address = process.env.RECIPIENT ?? Midday.Wallet.deriveAddress(seed, NETWORK);
console.log('network  :', NETWORK);
console.log('faucet   :', FAUCET);
console.log('recipient:', address);

const client = new FaucetClient(FAUCET, logger);

console.log('\nhealth:');
try {
  const h = await client.health();
  console.log('  ' + JSON.stringify(h.data));
} catch (e) {
  console.log('  failed:', String(e?.message ?? e).slice(0, 120));
}

console.log('\nrequesting 1000 tNIGHT:');
try {
  await client.requestTokens(address);
  console.log('  request accepted');
  writeFileSync('/tmp/faucet-recipient.txt', address + '\n');
} catch (e) {
  const body = e?.response?.data;
  console.log('  refused:', e?.response?.status ?? '', JSON.stringify(body ?? String(e?.message ?? e)).slice(0, 300));
}
process.exit(0);
