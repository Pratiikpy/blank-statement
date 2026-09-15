// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Talking to a Midnight browser wallet.
//
// The discovery rule is not ours to invent: midday-sdk's `findInjectedWallet`
// looks under `window.midnight`, prefers the legacy `mnLace` key, and otherwise
// accepts any entry exposing `connect()` and an `apiVersion` string. That is
// CAIP-372, and it is the whole contract. Reimplemented here rather than
// imported so the app does not have to bundle the SDK and its WASM to answer
// the question "is a wallet present".
//
// Worth stating plainly because it is the question that keeps coming up: an
// Ethereum wallet cannot serve this. Rabby and MetaMask inject `window.ethereum`
// and speak `request({ method: 'eth_*' })` over secp256k1. Midnight needs a
// different key type, a different transaction format, and a proof server to
// build a zero-knowledge proof before anything can be submitted. There is no
// shim; the interfaces do not overlap at any point.

/** The minimum DApp-connector major version midday-sdk will accept. */
export const REQUIRED_API_MAJOR = 4;

/** Every Midnight wallet currently injected, in discovery order. */
export function injectedWallets() {
  if (typeof window === 'undefined' || !window.midnight) return [];
  const found = [];
  const seen = new Set();
  const push = (key, api) => {
    if (!api || seen.has(api)) return;
    if (typeof api.connect !== 'function' || typeof api.apiVersion !== 'string') return;
    seen.add(api);
    found.push({ key, api, name: api.name ?? key, apiVersion: api.apiVersion });
  };
  push('mnLace', window.midnight.mnLace);
  for (const key of Object.keys(window.midnight)) push(key, window.midnight[key]);
  return found;
}

export const isCompatible = (apiVersion) =>
  Number(String(apiVersion).split('.')[0]) >= REQUIRED_API_MAJOR;

/**
 * A wallet names itself, and it does not know where that name will land. Lace
 * calls itself "lace", so any sentence that opens with the name reads as a typo
 * unless the first letter is raised. Only the first character is touched, so a
 * wallet that capitalises itself keeps exactly the name it chose.
 */
const opening = (name) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'The wallet');

/**
 * What the page can say about wallets right now, without asking for anything.
 * Deliberately distinguishes "none" from "present but too old" and from
 * "something is injected that is not a Midnight wallet", because those three
 * need different sentences.
 */
export function walletStatus() {
  const evmOnly = typeof window !== 'undefined' && !!window.ethereum && !window.midnight;
  const wallets = injectedWallets();
  if (!wallets.length) {
    return {
      state: evmOnly ? 'evm-only' : 'none',
      wallets: [],
      message: evmOnly
        ? 'The wallet in this browser is an Ethereum one. Midnight needs its own wallet, because the keys and the transaction format are different.'
        : 'No Midnight wallet in this browser.',
    };
  }
  const usable = wallets.filter((w) => isCompatible(w.apiVersion));
  if (!usable.length) {
    return {
      state: 'outdated',
      wallets,
      message: `${opening(wallets[0].name)} speaks connector ${wallets[0].apiVersion}; this needs ${REQUIRED_API_MAJOR} or newer.`,
    };
  }
  return { state: 'available', wallets: usable, message: `${opening(usable[0].name)} is ready to connect.` };
}

/**
 * Ask the wallet to connect. Returns a plain result rather than throwing, so
 * the caller does not have to tell a refusal apart from a crash.
 */
export async function connect(networkId = 'undeployed') {
  const status = walletStatus();
  if (status.state !== 'available') return { ok: false, ...status };
  const { api, name } = status.wallets[0];
  try {
    const session = await api.connect(networkId);
    if (!session) return { ok: false, state: 'refused', message: `${opening(name)} did not return a session.` };

    // Read the address from the connector's own accessors. An earlier version
    // called session.state(), which this API does not have: the call returned
    // undefined, the address stayed null, and the pill quietly showed the
    // wallet's name where an address belonged. Lace answers with objects, one
    // field each, and the unshielded address is the one a person recognises.
    const [unshielded, shielded, config] = await Promise.all([
      session.getUnshieldedAddress?.().catch(() => null) ?? null,
      session.getShieldedAddresses?.().catch(() => null) ?? null,
      session.getConfiguration?.().catch(() => null) ?? null,
    ]);

    return {
      ok: true,
      state: 'connected',
      name,
      apiVersion: api.apiVersion,
      address: unshielded?.unshieldedAddress ?? shielded?.shieldedAddress ?? null,
      coinPublicKey: shielded?.shieldedCoinPublicKey ?? null,
      networkId: config?.networkId ?? networkId,
      proverUri: config?.proverServerUri ?? null,
      proverWarning: proverMismatch(config?.networkId ?? networkId, config?.proverServerUri),
      session,
      message: `Connected to ${opening(name)}.`,
    };
  } catch (e) {
    return { ok: false, ...describeConnectError(e, name) };
  }
}

/**
 * Turn a thrown connector error into something worth showing someone.
 *
 * Lace rejects with a structured `APIError` carrying `type`, `code` and
 * `reason`, where code is one of InternalError, Rejected, InvalidRequest,
 * PermissionRejected or Disconnected. Reading the code beats matching words in
 * the message, which is wallet-specific prose that can change.
 *
 * The wording for a rejection has to cover two situations that look identical
 * from here. Someone may have pressed reject; or the wallet may hold no account
 * yet, in which case it opens its own setup screen and rejects the request in
 * the meantime. Lace calls both "User rejects wallet unlock". Saying "you
 * declined" to a first-time visitor who declined nothing is simply wrong, so
 * the sentence names both paths and stays true either way.
 */
export function describeConnectError(e, walletName = 'the wallet') {
  const who = opening(walletName);
  const raw = String(e?.message ?? e);
  const code = e?.code ?? null;
  const rejected = code === 'Rejected' || code === 'PermissionRejected' ||
    (code === null && /reject|denied|declin|cancel/i.test(raw));

  if (rejected) {
    return {
      state: 'declined',
      code,
      message: `${who} did not approve the connection. If you have not finished setting one up, do that in the wallet and try again.`,
    };
  }
  if (code === 'Disconnected') {
    return { state: 'disconnected', code, message: `${who} disconnected before it could answer.` };
  }
  return { state: 'failed', code, message: e?.reason ? String(e.reason) : raw };
}

/**
 * Does the wallet's proof server belong to the network it is on?
 *
 * Lace holds one proof server setting for every network, so the Local choice a
 * person needs for the local chain follows them onto preview, where it points
 * proving at their own machine. If that server is not running the write does
 * not fail, it hangs — measured at 313 seconds before it gave up — and nothing
 * on screen says which prover is being used.
 *
 * The app cannot change a wallet setting. It can say what it was handed, which
 * turns five minutes of a spinner into one sentence. See FINDING-04.
 */
export function proverMismatch(networkId, proverUri) {
  if (!networkId || !proverUri) return null;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(proverUri);
  if (networkId === 'undeployed') {
    // The local chain wants the local prover; a remote one cannot see its state.
    return local ? null
      : `The wallet is on the local network but proves at ${proverUri}. Set the proof server to Local in the wallet, and save it.`;
  }
  return local
    ? `The wallet is on ${networkId} but proves on this machine (${proverUri}). If that server is not running, a write will hang rather than fail. Set the proof server to Remote in the wallet, and save it.`
    : null;
}
