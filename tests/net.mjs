// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Which chain a test talks to.
//
// Every suite used to carry its own copy of the local endpoints, which was fine
// while there was only one chain. Running the same suites against a public
// network means that choice has to live in one place, or half the tests quietly
// keep reading the local chain while the other half writes to preview, and the
// results mean nothing.
//
// Defaults to the local stack: a suite run without thinking should not be able
// to spend real fees.
export const NETWORK = process.env.NETWORK ?? 'undeployed';

export const NET = NETWORK === 'undeployed'
  ? {
    networkId: 'undeployed',
    indexer: 'http://127.0.0.1:8188/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:8188/api/v4/graphql/ws',
    node: 'ws://127.0.0.1:9944',
    proofServer: 'http://127.0.0.1:6300',
  }
  : {
    networkId: NETWORK,
    indexer: `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`,
    indexerWS: `wss://indexer.${NETWORK}.midnight.network/api/v4/graphql/ws`,
    node: `wss://rpc.${NETWORK}.midnight.network`,
    proofServer: `https://proof-server.${NETWORK}.midnight.network`,
  };

/** The bridge serving that chain. One bridge at a time, on one port. */
export const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';

/**
 * The wallet a read-only test opens.
 *
 * Joining a contract needs a wallet, but reading its ledger state does not need
 * a funded one, so the same throwaway seed works on every network. It is never
 * used to sign: the suites that use it install witnesses that throw.
 *
 * On a public network this wallet is empty and has to sync from genesis, which
 * takes minutes. That is the price of reading the truth rather than trusting
 * the bridge, and it is worth paying.
 */
export const READER_SEED = process.env.READER_SEED ?? '0'.repeat(63) + '9';

export const describe = () => `${NETWORK} via ${NET.indexer}`;
