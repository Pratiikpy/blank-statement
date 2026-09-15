// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The contract, driven from the browser against the visitor's own wallet.
//
// This is the difference the README leads with. Every write until now went
// through app/bridge.mjs, a Node process holding a seed wallet and talking to
// the proof server on the holder's behalf. That works, but it means the record
// and the key both sit in a process the holder does not own, which is the
// arrangement this product exists to avoid.
//
// The wiring below follows Midnight's own reference DApp for the version 4
// connector (midnightntwrk/midnight-wallet-dapp, src/lib), which builds against
// the same versions this project does: dapp-connector-api 4.0.1, ledger-v8
// 8.1.0, midnight-js 4.1.1. An earlier version of this file approximated that
// wiring through midday's higher-level Client; this uses the shape the people
// who wrote the connector use, because three things about it are not guessable:
//
//   * `getProvingProvider` is declared on the connector but not implemented —
//     the reference marks it TODO and proves over HTTP against the network's
//     own proof server instead. Calling it throws "not a function".
//   * `fetch` has to be passed as `fetch.bind(window)`. Unbound, it fails deep
//     inside a provider as "Illegal invocation", nowhere near the cause.
//   * the public data provider needs `postBlockUpdate` applied to the zswap
//     state on every read, or contract state comes back stale.
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Transaction } from '@midnight-ntwrk/ledger-v8';

/** Where the compiled circuit, its prover keys and its zkir are served from. */
const ZK_BASE = new URL('/contracts/out/', window.location.origin).href;

const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => {
  const pairs = hex.replace(/^0x/, '').match(/.{1,2}/g);
  return pairs ? new Uint8Array(pairs.map((b) => parseInt(b, 16))) : new Uint8Array();
};

/** Every Midnight wallet currently injected, newest connector first. */
export function injectedConnectors() {
  if (typeof window === 'undefined' || !window.midnight) return [];
  return Object.entries(window.midnight)
    .filter(([, api]) => api && typeof api.connect === 'function' && typeof api.apiVersion === 'string')
    .map(([key, api]) => ({ key, api, name: api.name ?? key, apiVersion: api.apiVersion }));
}

/**
 * Ask the wallet to connect, and build the providers a contract call needs.
 *
 * Returns a plain result rather than throwing: a wallet refusing is an ordinary
 * outcome, not an exception, and every caller would otherwise have to guard it.
 */
/**
 * Submit through a fee relay instead of the wallet.
 *
 * A wallet has to hold DUST to pay a fee, and DUST only comes from NIGHT that
 * was registered for DUST generation at mint time. A holder who received their
 * NIGHT from anyone other than a faucet has NIGHT and no DUST, and cannot fix
 * it themselves: registering is itself a transaction, so it needs the fee it
 * does not have. Both Lace's own Generate tDUST and the SDK's registerDust()
 * fail on such a wallet with `Invalid Transaction: Custom error: 192`, on the
 * public network and on a local one alike.
 *
 * That is a bad thing to hand a person who only wants to answer a question
 * about their own receipts. So the fee is not their problem: the wallet proves
 * and signs, and the relay pays. The wallet still authorises everything, and
 * the relay never sees a key.
 */
function relayProvider(relayUrl) {
  const base = relayUrl.replace(/\/$/, '');
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(`the fee relay refused ${path}: ${err.error ?? r.statusText}`);
    }
    return r.json();
  };
  return {
    async submitTx(tx) {
      const { tx: balanced } = await post('/balance-finalized-tx', { tx: toHex(tx.serialize()) });
      if (!balanced) throw new Error('the fee relay returned an empty transaction');
      const { txId } = await post('/submit-tx', { tx: balanced });
      return txId;
    },
  };
}

export async function connectWalletProviders({ networkId = 'undeployed', feeRelay = null } = {}) {
  const found = injectedConnectors();
  if (!found.length) return { ok: false, state: 'none', message: 'No Midnight wallet in this browser.' };

  const { api, name } = found[0];
  let session;
  try {
    // No timeout on purpose: this opens a permission prompt, and hurrying
    // someone reading one is how they approve things they have not read.
    session = await api.connect(networkId);
  } catch (e) {
    const code = e?.code ?? null;
    if (code === 'Rejected' || code === 'PermissionRejected') {
      return { ok: false, state: 'declined', code, message: `${name} did not approve the connection.` };
    }
    return { ok: false, state: 'failed', code, message: String(e?.reason ?? e?.message ?? e).slice(0, 200) };
  }
  if (!session) return { ok: false, state: 'refused', message: `${name} returned no session.` };

  try {
    const config = await session.getConfiguration();
    const shielded = await session.getShieldedAddresses();
    const { unshieldedAddress } = await session.getUnshieldedAddress();

    // Bound on purpose. See the note at the top of this file.
    const zkConfigProvider = new FetchZkConfigProvider(ZK_BASE, fetch.bind(window));
    const proofProvider = httpClientProofProvider(config.proverServerUri, zkConfigProvider);

    const rawPublic = indexerPublicDataProvider(config.indexerUri, config.indexerWsUri);
    const publicDataProvider = {
      ...rawPublic,
      async queryZSwapAndContractState(address, queryConfig) {
        const result = await rawPublic.queryZSwapAndContractState(address, queryConfig);
        if (!result) return result;
        const [zswap, contractState, ledgerParameters] = result;
        // Without this the zswap state is as of its last block and coin
        // selection works from a stale view.
        return [zswap.postBlockUpdate(new Date()), contractState, ledgerParameters];
      },
    };

    const walletProvider = {
      getCoinPublicKey: () => shielded.shieldedCoinPublicKey,
      getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey,
      // The wallet balances and signs: the page never sees a key.
      async balanceTx(tx) {
        // With a relay, the wallet must NOT add a fee, or it fails on a wallet
        // with no DUST and there would be two fees on the ones that have some.
        const { tx: balanced } = await session.balanceUnsealedTransaction(
          toHex(tx.serialize()),
          feeRelay ? { payFees: false } : undefined,
        );
        return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced));
      },
    };

    const midnightProvider = feeRelay ? relayProvider(feeRelay) : {
      async submitTx(tx) {
        await session.submitTransaction(toHex(tx.serialize()));
        return tx.identifiers()[0];
      },
    };

    return {
      ok: true,
      state: 'connected',
      name,
      apiVersion: api.apiVersion,
      networkId: config.networkId,
      address: unshieldedAddress,
      coinPublicKey: shielded.shieldedCoinPublicKey,
      config,
      session,
      feeRelay,
      providers: { publicDataProvider, zkConfigProvider, proofProvider, walletProvider, midnightProvider },
      message: `Connected to ${name}.`,
    };
  } catch (e) {
    return { ok: false, state: 'failed', message: String(e?.message ?? e).slice(0, 250) };
  }
}

/**
 * What the wallet holds. A wallet with no DUST cannot pay a fee, so it cannot
 * sign anything, and every write fails in a way that looks like the button
 * doing nothing. Worth checking before offering to write.
 */
export async function walletFunds(session) {
  const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };
  const dust = await safe(() => session.getDustBalance(), { balance: 0n, cap: 0n });
  const unshielded = await safe(() => session.getUnshieldedBalances(), {});
  const night = Object.values(unshielded ?? {}).reduce((a, b) => a + BigInt(b ?? 0n), 0n);
  const balance = BigInt(dust?.balance ?? 0n);
  return {
    dust: balance,
    dustCap: BigInt(dust?.cap ?? 0n),
    night,
    // The balance is the whole question: a wallet with DUST can pay a fee.
    //
    // An earlier version of this read `cap` and reported "no NIGHT registered"
    // whenever it was zero. That was wrong, and it was wrong in the direction
    // that matters: the local chain's own funded wallet reports a DUST balance
    // of 1.2e24 with a cap of 0, and it signs every transaction this project
    // has ever made. Reporting that wallet as unable to sign would have sent
    // someone hunting a registration problem they did not have.
    canPayFees: balance > 0n,
  };
}
