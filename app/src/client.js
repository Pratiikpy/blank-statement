// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The product, without a server.
//
// The bridge was always a development shortcut, and it carried the one thing
// this product exists to avoid: whatever does the proving sees the witnesses,
// which are the receipt amounts. A hosted bridge is a hosted copy of everyone's
// bank statement. So there is no bridge here. The wallet signs, the browser
// proves, and the record never leaves this machine.
//
// It mirrors the shape the interface already used — state, record, import,
// request, answer, statement — so the screens did not have to be rewritten to
// stop trusting a server.
//
// The private state lives in localStorage. That is the right place for it: it
// is per-browser, it never travels, and losing it loses only the ability to
// answer, never the anchored history, which is on the chain.
import { parseCsv, toBatches, summarise, counterpartyId, BATCH_SIZE, RUN_LENGTH } from '../import.mjs';

// The SDK and the wallet layer are imported where they are used, not at the
// top. Both reach for top-level await, which lands the proving machinery in the
// first chunk the browser parses — a page most visitors are only reading. It
// also breaks the top-level-await transform outright when it is bundled into
// the entry chunk.
const sdk = () => import('@no-witness-labs/midday-sdk');
const chain = () => import('./chain.js');
const netId = () => import('@midnight-ntwrk/midnight-js-network-id');

const ZERO = new Uint8Array(32);
const enc = new TextEncoder();
const hex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
const txt = (u) => new TextDecoder().decode(u).replace(/\0+$/, '');

/** A caller mistake, not a chain refusal. The interface words these differently. */
export class BadInput extends Error {}

/**
 * Text that has to survive a round trip through a Bytes<32> ledger field, so it
 * is padded rather than hashed. A name longer than that cannot round trip, and
 * shortening it silently would publish a different name than the one typed.
 */
function label32(s, field) {
  const b = enc.encode(String(s ?? ''));
  if (b.length === 0) throw new BadInput(`${field} is empty`);
  if (b.length > 32) throw new BadInput(`${field} is ${b.length} bytes; the ledger field holds 32`);
  const u = new Uint8Array(32);
  u.set(b);
  return u;
}

/* ---------- what stays in this browser ---------- */

const KEY = 'blank.statement.v1';

/**
 * localStorage holds strings, and the private state is full of Uint8Arrays and
 * BigInts. Both have to survive the round trip exactly: a checkpoint id is a
 * hash of these values, so a byte array that comes back as an object of
 * numbered keys silently breaks the chain at the next answer.
 */
const revive = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (v.__b) return new Uint8Array(v.__b);
  if (v.__n) return BigInt(v.__n);
  if (Array.isArray(v)) return v.map(revive);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
};
const plain = (v) => {
  if (typeof v === 'bigint') return { __n: v.toString() };
  if (v instanceof Uint8Array) return { __b: Array.from(v) };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? revive(JSON.parse(raw)) : null;
  } catch { return null; }
}
function save(store) {
  try { localStorage.setItem(KEY, JSON.stringify(plain(store))); } catch { /* private mode */ }
}

/**
 * The holder's secret. Generated here, once, and never sent anywhere: it is the
 * only thing that makes a statement yours, and it is the input to the nullifier
 * that stops one being used twice.
 */
function holderSecret(store) {
  if (store.sk) return store.sk;
  store.sk = crypto.getRandomValues(new Uint8Array(32));
  save(store);
  return store.sk;
}

const blank = () => ({ sk: null, address: null, run: null, record: null, network: null });

/* ---------- the contract, in this browser ---------- */

const witnesses = {
  holderSk: ({ privateState: s }) => [s, s.sk],
  batchAmounts: ({ privateState: s }) => [s, s.batchAmounts],
  batchCounterparties: ({ privateState: s }) => [s, s.batchCps],
  batchCount: ({ privateState: s }) => [s, s.batchCount],
  chain: ({ privateState: s }) => [s, s.chain],
  chainRands: ({ privateState: s }) => [s, s.chainRands],
  membership: ({ privateState: s }) => [s, s.path],
};

let session = null;   // wallet + providers, once connected
let contract = null;  // the loaded module
let joined = null;    // the deployed handle

/**
 * ONE private state object, mutated in place.
 *
 * The witnesses are handed whatever object was passed as initialPrivateState,
 * so the only way to change what a circuit reads between two calls is to
 * mutate that same object. Building a fresh one per call leaves the contract
 * reading the first one forever, which shows up as a checkpoint chain that
 * does not link.
 */
let PS = null;

/** Every checkpoint needs its own randomness, or two anchorings of the same
 *  batch commit to the same leaf and a membership path cannot tell them apart. */
const freshRand = () => crypto.getRandomValues(new Uint8Array(32));

const emptyPrivate = (sk) => ({
  sk,
  batchAmounts: Array.from({ length: BATCH_SIZE }, () => 0n),
  batchCps: Array.from({ length: BATCH_SIZE }, () => ZERO),
  batchCount: 0n,
  chain: undefined,
  chainRands: undefined,
  path: undefined,
});

/**
 * Connect the wallet and load the contract. Everything else assumes this ran.
 *
 * The contract module is imported lazily: it pulls in the proving artefacts,
 * and loading those on first paint delays a page most visitors are only
 * reading.
 */
export async function open({ networkId, feeRelay = null, address = null } = {}) {
  const store = load() ?? blank();
  const sk = holderSecret(store);

  // Before anything touches a wallet or a contract. Without it the first
  // write fails as "Network ID has not been configured", which happens deep
  // inside deploy and reads like a wallet fault rather than a missing setup
  // call. It is global state in the SDK, not a parameter.
  const { setNetworkId } = await netId();
  setNetworkId(networkId ?? store.network ?? 'undeployed');

  const { connectWalletProviders } = await chain();
  const wc = await connectWalletProviders({
    networkId: networkId ?? store.network ?? 'undeployed',
    feeRelay,
  });
  if (!wc.ok) return wc;
  session = wc;
  store.network = wc.config?.networkId ?? networkId ?? store.network;

  const C = await import('../../contracts/out/contract/index.js');
  const M = await sdk();
  PS = emptyPrivate(sk);
  contract = await M.Contract.create({
    module: C,
    // fromUrl, not fromPath: fromPath reads a filesystem, which a browser does
    // not have, and fails as "Failed to read verifier key" — which reads like a
    // missing artefact rather than the wrong reader.
    zkConfig: M.ZkConfig.fromUrl(new URL('/contracts/out', window.location.origin).href),
    privateStateId: 'blank-statement-browser',
    witnesses,
    initialPrivateState: PS,
    walletProvider: wc.providers.walletProvider,
    midnightProvider: wc.providers.midnightProvider,
    publicDataProvider: wc.providers.publicDataProvider,
    privateStateProvider: M.PrivateState.inMemoryPrivateStateProvider(),
    proofServerUrl: wc.config.proverServerUri,
  });

  const target = address ?? store.address;
  joined = target
    ? await contract.join(target, { initialPrivateState: PS })
    : await contract.deploy({ initialPrivateState: PS });
  store.address = joined.address;
  save(store);

  return { ok: true, address: joined.address, network: store.network, wallet: wc };
}

export const isOpen = () => !!joined;
export const contractAddress = () => joined?.address ?? load()?.address ?? null;

/* ---------- reads ---------- */

/** The ledger, read directly. Nothing here is taken from a server's word. */
export async function state() {
  if (!joined) throw new BadInput('connect a wallet first');
  const st = await joined.ledgerState();
  const nowMs = Date.now();

  const requests = [];
  for (const [k, v] of st.requests) {
    requests.push({
      id: txt(k),
      verifier: txt(v.verifierPk),
      threshold: v.threshold.toString(),
      expiry: v.expiry.toString(),
      open: v.open,
      bound: hex(v.holderId) !== hex(ZERO),
      holderId: hex(v.holderId),
      expired: Number(v.expiry) * 1000 < nowMs,
    });
  }
  const verdicts = [];
  for (const [k, v] of st.verdicts) {
    verdicts.push({
      id: hex(k).slice(0, 16),
      fullId: hex(k),
      met: v.met,
      threshold: v.threshold?.toString() ?? null,
      concentrationOk: v.concentrationOk,
      batches: Number(v.batches),
      receiptCount: Number(v.receiptCount),
      verifier: txt(v.verifierPk),
    });
  }
  return {
    network: load()?.network ?? null,
    address: joined.address,
    issued: st.issued.toString(),
    blockTime: nowMs,
    // One holder: whoever is using this browser. The bridge carried several
    // because it was a demo; a person is only ever themselves.
    holders: [{ id: 'you', label: 'You', note: 'this browser' }],
    requests,
    verdicts,
  };
}

/** The record, which lives here and only here. */
export function record() {
  return load()?.record ?? null;
}

export async function statement(id) {
  const s = await state();
  const v = s.verdicts.find((x) => x.id === id || x.fullId === id);
  if (!v) return { ok: false, status: 404, error: 'no statement with that reference' };
  return { ok: true, ...v, address: s.address };
}

/* ---------- writes ---------- */

/**
 * Anchor a record. Each batch is one transaction, and a history shorter than a
 * run is padded with empty batches so the run length says nothing about how
 * much history there is.
 */
export async function importCsv(csv, onProgress) {
  if (!joined) throw new BadInput('connect a wallet first');
  const rows = parseCsv(csv);
  if (!rows.length) throw new BadInput('no receipts in that file');
  const batches = toBatches(rows);
  const summary = summarise(rows, batches);
  const use = batches.slice(0, RUN_LENGTH);

  const store = load() ?? blank();
  const C = await import('../../contracts/out/contract/index.js');
  const made = [];
  let prev = ZERO;

  for (let i = 0; i < RUN_LENGTH; i++) {
    const batch = use[i];
    // A run is always RUN_LENGTH long, so a short history costs the same to
    // prove as a long one and the length reveals nothing. Padding carries no
    // money, and its counterparties are distinct — the circuit refuses a batch
    // that names the same client twice, and eight identical zeros would be
    // exactly that.
    const amounts = batch ? batch.amounts : Array.from({ length: BATCH_SIZE }, () => 0n);
    const cps = batch
      ? batch.counterparties
      : Array.from({ length: BATCH_SIZE }, (_, k) => counterpartyId(`__fill:${i}:${k}:${Date.now()}`));
    const count = BigInt(batch ? batch.real : 0);
    const rand = freshRand();

    // Mutate in place; see the note on PS.
    PS.batchAmounts = amounts;
    PS.batchCps = cps;
    PS.batchCount = count;

    await joined.actions.anchorCheckpoint(prev, rand);

    const total = amounts.reduce((a, x) => a + x, 0n);
    const largest = amounts.reduce((a, x) => (x > a ? x : a), 0n);
    const cp = { prev, total, count, largest };
    const id = C.pureCircuits.checkpointIdOf(cp, rand);
    made.push({ cp, rand, id });
    prev = id;
    onProgress?.(i + 1, RUN_LENGTH);
  }

  // Newest first, which is the order the circuit walks the run in.
  const newestFirst = made.slice().reverse();
  store.run = {
    chain: newestFirst.map((m) => m.cp),
    chainRands: newestFirst.map((m) => m.rand),
    // The path is deliberately NOT stored: every later anchoring changes the
    // tree root, and a path taken now stops verifying the moment anyone else
    // anchors. Keep the leaf and derive the path when a statement is made.
    leaf: newestFirst[0].id,
  };
  store.record = {
    source: 'import',
    receipts: summary.receipts,
    counterparties: summary.counterparties,
    total: summary.total.toString(),
    coveredReceipts: summary.coveredReceipts,
    batches: summary.batches,
    truncated: summary.truncated,
    rows: rows.map((r, i) => ({
      date: r.date,
      counterparty: r.counterparty,
      amount: r.amount.toString(),
      anchored: i < summary.coveredReceipts,
    })),
  };
  save(store);
  return { ok: true, record: store.record, summary };
}

export async function createRequest({ id, verifier, threshold, ttlSeconds = 3600, boundTo = null }) {
  if (!joined) throw new BadInput('connect a wallet first');
  const ref = label32(id, 'the reference');
  const who = label32(verifier, 'your name');
  const amount = BigInt(threshold);
  if (amount <= 0n) throw new BadInput('the amount asked for has to be more than nothing');
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new BadInput('the expiry is not a number of seconds');

  // Binding an ask to "you" means binding it to this browser's holder id,
  // which is derived from the secret that never leaves it.
  const C = await import('../../contracts/out/contract/index.js');
  const bind = boundTo ? C.pureCircuits.holderIdOf(holderSecret(load() ?? blank())) : ZERO;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + ttl);
  const r = await joined.actions.createRequest(ref, who, bind, amount, expiry);
  return { ok: true, txHash: r?.txHash ?? null };
}

/**
 * Answer an ask. The proof is built here, in this browser, from a record that
 * has never been anywhere else.
 */
export async function answerRequest({ id, nonce }) {
  if (!joined) throw new BadInput('connect a wallet first');
  const store = load() ?? blank();
  if (!store.run) throw new BadInput('no record anchored yet');

  const ref = label32(id, 'the reference');
  const n = label32(nonce ?? 'n-' + Date.now(), 'the nonce');

  // The path has to be derived against the tree as it stands right now.
  const tree = await joined.ledgerState();
  const path = tree.receipts.findPathForLeaf(store.run.leaf);
  if (!path) throw new BadInput('your newest entry is not on this chain any more');

  PS.chain = store.run.chain;
  PS.chainRands = store.run.chainRands;
  PS.path = path;

  // Snapshot the verdict set first. Ledger map iteration is not insertion
  // order, so "the last row" is not "the new row".
  const before = new Set((await state()).verdicts.map((x) => x.id));
  const r = await joined.actions.answerRequest(ref, n);
  const after = await state();
  const v = after.verdicts.find((x) => !before.has(x.id)) ?? null;
  return { ok: true, settled: true, txHash: r?.txHash ?? null, verdict: v };
}

/** Forget everything this browser holds. The anchored history stays on chain. */
export function forget() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  joined = null; contract = null; session = null; PS = null;
}
