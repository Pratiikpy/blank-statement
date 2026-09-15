// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Print the unshielded address of the local test seed on each network.
//
// The faucet takes the unshielded `mn_addr_` form only, and the address encodes
// its network: a preprod faucet will not fund a preview address and the wallet
// will never see it. This makes both explicit so the right one gets pasted.
import * as Midday from '@no-witness-labs/midday-sdk';
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const SEED_FILE = process.env.SEED_FILE ?? `${process.env.HOME}/.cache/blank-statement/preview-seed.txt`;

let seed;
if (existsSync(SEED_FILE)) {
  seed = readFileSync(SEED_FILE, 'utf8').trim();
} else {
  seed = randomBytes(32).toString('hex');
  writeFileSync(SEED_FILE, seed + '\n');
  console.log('generated a new seed, saved to', SEED_FILE);
}

for (const net of (process.env.NETWORKS ?? 'preview,preprod').split(',')) {
  console.log(`${net.padEnd(9)} ${Midday.Wallet.deriveAddress(seed, net)}`);
}
process.exit(0);
