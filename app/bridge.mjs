// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Local bridge: owns the wallet and the proving, exposes the deployed contract
// to the UI. Dev path only. Proving happens on the user's own machine against
// the local proof server. It must not become a hosted service, because whatever
// does the proving sees the witnesses, which are the private receipt amounts.
import { createServer } from 'http';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as Midday from '@no-witness-labs/midday-sdk';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import {
  parseCsv, toBatches, summarise, counterpartyId,
  BATCH_SIZE, RUN_LENGTH, STATEMENT_CAPACITY,
} from './import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
// pathToFileURL, not a bare path: a Windows drive letter in a bare specifier is
// read as a URL scheme and the import fails before anything else can.
const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);

/**
 * Which chain this bridge talks to.
 *
 * Defaults to the local stack, because that is where the tests run and where a
 * mistake costs nothing. Set NETWORK to `preview` or `preprod` and the public
 * endpoints follow, which is what makes it possible to run the whole product
 * against a real network rather than only against a chain we control.
 */
const NETWORK = process.env.NETWORK ?? 'undeployed';
const NET = NETWORK === 'undeployed'
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

/**
 * The wallet that pays the fees, when it is not the local dev preset.
 *
 * On the local chain the preset funds three seeds and each holder gets one. A
 * public network funds nobody, so there every holder shares the single wallet
 * that has DUST. That is only about who pays: a holder's identity in the
 * circuit comes from their `sk`, which stays their own, exactly as it already
 * does for Rae on the local chain.
 *
 * Sharing one wallet across concurrent writers causes submission collisions,
 * so every write here goes through `serial()`. See FINDING-03.
 */
const BRIDGE_SEED = process.env.BRIDGE_SEED ?? null;

/**
 * Where a public-network deployment is remembered.
 *
 * On the local chain a restart just redeploys and reseeds, and it costs
 * nothing. On preview it costs a real fee per anchor: bringing up one holder is
 * eight anchors plus a deploy, which is most of what a funded wallet can
 * afford. Losing that to a restart, and paying it again, is not acceptable.
 *
 * So the contract address and each holder's anchored run are written down, and
 * a later start rejoins rather than rebuilding. The file is keyed by network,
 * because a run anchored on preview means nothing on the local chain.
 */
const STATE_FILE = process.env.BRIDGE_STATE
  ?? join(__dirname, `../.bridge-state-${NETWORK}.json`);
const RESUME = process.env.BRIDGE_RESUME !== '0' && NETWORK !== 'undeployed';

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (t) => new Uint8Array(Buffer.from(t, 'base64'));

function loadState() {
  if (!RESUME || !existsSync(STATE_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (j.network !== NETWORK) return null;
    return j;
  } catch { return null; }
}

function saveState(address) {
  if (!RESUME) return;
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      network: NETWORK,
      address,
      runs: Object.fromEntries(Object.entries(runs).map(([who, r]) => [who, {
        chain: r.chain.map((c) => ({
          prev: b64(c.prev), total: String(c.total),
          count: String(c.count), largest: String(c.largest),
        })),
        chainRands: r.chainRands.map(b64),
        leaf: b64(r.leaf),
      }])),
      records,
    }, null, 2));
  } catch (e) {
    console.log('bridge: could not save state:', e.message);
  }
}

function restoreRuns(saved) {
  for (const [who, r] of Object.entries(saved.runs ?? {})) {
    runs[who] = {
      chain: r.chain.map((c) => ({
        prev: unb64(c.prev), total: BigInt(c.total),
        count: BigInt(c.count), largest: BigInt(c.largest),
      })),
      chainRands: r.chainRands.map(unb64),
      leaf: unb64(r.leaf),
    };
  }
  for (const [who, rec] of Object.entries(saved.records ?? {})) records[who] = rec;
}

const enc = new TextEncoder();
const hex = (u) => Buffer.from(u).toString('hex');
const txt = (u) => Buffer.from(u).toString('utf8').replace(/\0+$/, '');
const ZERO = new Uint8Array(32);

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

/** A caller mistake, not a chain rejection and not an outage. */
class BadInput extends Error {}

// Two demo holders, so the bound-request path can actually be shown. Alice
// carries a year of freelance income; Mallory carries a thin one, which is what
// makes an overclaim from Mallory produce a readable "not met".
const demoReceipts = (names, amounts, year) =>
  amounts.map((a, i) => ({
    date: `${year}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 26) + 2).padStart(2, '0')}`,
    counterparty: names[i % names.length],
    amount: a,
  }));

const ALICE_CLIENTS = [
  'Acme Ltd', 'Borden Studio', 'Cadence Labs', 'Delta Works', 'Eiger Group',
  'Fathom', 'Gravity Type', 'Halden & Co', 'Ilex Media', 'Juno Partners',
  'Kestrel Design', 'Lumen Analytics',
];
const ALICE_AMOUNTS = Array.from({ length: 64 }, (_, i) =>
  BigInt(45000 + ((i * 7919) % 260) * 500));

// Four holders, chosen so the states a verifier actually cares about are all
// reachable from the interface: a long even history, a thin one, a history one
// client dominates, and a brand new one.
const HOLDERS = {
  alice: {
    label: 'Alice',
    note: 'A full year, evenly spread',
    seed: '0'.repeat(63) + '1',
    sk: label32('alice-secret-key', 'holder key'),
    receipts: demoReceipts(ALICE_CLIENTS, ALICE_AMOUNTS, 2026),
  },
  mallory: {
    label: 'Mallory',
    note: 'A thin history',
    seed: '0'.repeat(63) + '2',
    sk: label32('mallory-secret-key', 'holder key'),
    receipts: demoReceipts(
      ['Nyx Ltd', 'Orrery', 'Pike Studio', 'Quill'],
      [10000n, 12000n, 9000n, 8000n, 14000n, 7000n, 11000n, 9500n],
      2026,
    ),
  },
  // One retainer worth more than everything else put together, so this holder
  // publishes concentrationOk: false. Without a case like this the interface
  // can only ever be seen saying "no receipt is worth more than half".
  chidi: {
    label: 'Chidi',
    note: 'One client worth more than all the rest',
    seed: '0'.repeat(63) + '3',
    sk: label32('chidi-secret-key', 'holder key'),
    receipts: demoReceipts(
      ['Northwind Trading Company Limited (UK)', 'Northwind Trading Company Limited (IE)',
       'Sable Design', 'Torus Systems', 'Umbra Print'],
      [900000n, 12000n, 8000n, 15000n, 9000n, 11000n, 7500n, 13000n, 6000n, 10500n],
      2026,
    ),
  },
  // Three receipts. Proves the published count is the real one at the small
  // end: this holder's statements say 3 receipts in 1 batch, not 64 in 8.
  rae: {
    label: 'Rae',
    note: 'Just starting out, three receipts',
    // This network's dev preset funds exactly three wallets, so Rae shares
    // Alice's. Her holder key, and therefore her identity in the circuit, is
    // still entirely her own; only who pays the fee is shared.
    seed: '0'.repeat(63) + '1',
    sk: label32('rae-secret-key', 'holder key'),
    receipts: demoReceipts(['Vellum Co', 'Wick Studio', 'Yarrow'], [25000n, 18000n, 32000n], 2026),
  },
};
/**
 * Which holders to bring up.
 *
 * All four locally, where a transaction costs nothing. On a public network each
 * holder costs eight anchors in real fees, so BRIDGE_HOLDERS=alice brings up
 * one and leaves the rest out rather than quietly running out of DUST halfway
 * through and leaving the chain ahead of the interface.
 */
const WHO = (() => {
  const asked = (process.env.BRIDGE_HOLDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!asked.length) return Object.keys(HOLDERS);
  const unknown = asked.filter((w) => !HOLDERS[w]);
  if (unknown.length) throw new Error(`no holder called ${unknown.join(', ')}`);
  return asked;
})();

// Only the holders that were actually brought up are offered in the interface.
const HOLDER_LIST = WHO.map((id) => ({ id, label: HOLDERS[id].label, note: HOLDERS[id].note }));

/**
 * One private state per holder, not one shared object. Each holder's contract
 * handle is loaded with its own, so a witness call can only ever read the
 * receipts of the holder it belongs to. The serial queue below still exists,
 * but it now guards ordering rather than papering over shared mutable state.
 */
const blankState = (who) => ({
  sk: HOLDERS[who].sk,
  batchAmounts: Array.from({ length: BATCH_SIZE }, () => 0n),
  batchCps: Array.from({ length: BATCH_SIZE }, (_, i) => counterpartyId(`__init-${who}-${i}`)),
  batchCount: 0n,
  chain: undefined,
  chainRands: undefined,
  path: undefined,
});
const states = Object.fromEntries(Object.keys(HOLDERS).map((w) => [w, blankState(w)]));
const witnesses = {
  holderSk:            ({ privateState }) => [privateState, privateState.sk],
  batchAmounts:        ({ privateState }) => [privateState, privateState.batchAmounts],
  batchCounterparties: ({ privateState }) => [privateState, privateState.batchCps],
  batchCount:          ({ privateState }) => [privateState, privateState.batchCount],
  chain:               ({ privateState }) => [privateState, privateState.chain],
  chainRands:          ({ privateState }) => [privateState, privateState.chainRands],
  membership:          ({ privateState }) => [privateState, privateState.path],
};

/**
 * A wallet per holder. Each pays its own fees from its own DUST, which is what
 * a real deployment looks like: the holder's machine, the holder's key. It also
 * lifts the concurrency ceiling, because the limit measured on this network is
 * per wallet rather than per ledger.
 *
 * The first holder deploys; everyone else joins the same address, so all of
 * them write the same contract state.
 */
console.log(`bridge: connecting to ${NETWORK}...`);
const saved = loadState();
if (saved) console.log('bridge: found a saved deployment for', NETWORK);
const deps = {};
const wallets = {};

for (const [i, who] of WHO.entries()) {
  const wallet = await Midday.Wallet.fromSeed(BRIDGE_SEED ?? HOLDERS[who].seed, NET);
  wallets[who] = wallet;
  const client = await Midday.Client.create({
    wallet, networkConfig: NET,
    privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
  });
  const loaded = await client.loadContract({
    module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
    privateStateId: 'blank-statement-' + who, witnesses, initialPrivateState: states[who],
  });
  // Rejoin a contract this bridge already paid to deploy, rather than paying
  // again. Only ever on a public network; locally a fresh deploy is free and
  // a clean slate is worth more.
  const target = i === 0 ? saved?.address : deps[WHO[0]].address;
  if (target) {
    if (i === 0) console.log('bridge: rejoining the contract from', STATE_FILE);
    deps[who] = await loaded.join(target, { initialPrivateState: states[who] });
    if (i === 0) console.log('bridge: contract at', deps[who].address);
  } else {
    console.log('bridge: deploying contract...');
    deps[who] = await loaded.deploy({ initialPrivateState: states[who] });
    console.log('bridge: contract at', deps[who].address);
  }
  console.log(`bridge: ${who} on wallet ${wallet.address.slice(0, 24)}…`);
}

// Reads and the verifier's own writes go through the first holder's handle;
// they touch no private state.
const dep = deps[WHO[0]];

// Every checkpoint gets its own randomness. Two anchorings of the same batch
// would otherwise commit to the same leaf, and findPathForLeaf could not tell
// them apart.
let anchorSeq = 0;
const nextRand = () => {
  const u = new Uint8Array(32);
  u.set(enc.encode(`blank:rand:${anchorSeq++}:${process.pid}`).slice(0, 32));
  return u;
};

// The witnesses for each holder's most recent run, and the record that run
// describes. They are built together by anchorRun so the screen and the chain
// cannot drift apart.
const runs = {};
const records = {};

/**
 * Anchor a holder's receipts as a run of RUN_LENGTH checkpoints and return the
 * record that run proves. Batches past the run cannot be folded into a
 * statement, so they are imported but never counted as anchored.
 */
async function anchorRun(who, receipts, { source, skipped = [], onProgress } = {}) {
  const batches = toBatches(receipts);
  const summary = summarise(receipts, batches);
  const use = batches.slice(0, RUN_LENGTH);

  const ps = states[who];
  const holderDep = deps[who];
  const saved = { ...ps };
  const made = [];
  let prev = new Uint8Array(32);
  let settled = 0;
  try {
    ps.sk = HOLDERS[who].sk;
    for (let i = 0; i < RUN_LENGTH; i++) {
      const batch = use[i];
      // Padding batches carry no money and no real counterparties, so a short
      // history costs the same to prove as a long one and reveals nothing
      // about which it was.
      const amounts = batch ? batch.amounts : Array.from({ length: BATCH_SIZE }, () => 0n);
      const cps = batch
        ? batch.counterparties
        : Array.from({ length: BATCH_SIZE }, (_, k) => counterpartyId(`__fill:${who}:${anchorSeq}:${i}:${k}`));
      const count = batch ? batch.real : 0;

      ps.batchAmounts = amounts;
      ps.batchCps = cps;
      ps.batchCount = BigInt(count);

      const rand = nextRand();
      const r = await holderDep.actions.anchorCheckpoint(prev, rand);
      settled++;
      const cp = {
        prev,
        total: amounts.reduce((a, x) => a + x, 0n),
        count: BigInt(count),
        largest: amounts.reduce((a, x) => (x > a ? x : a), 0n),
      };
      const id = C.pureCircuits.checkpointIdOf(cp, rand);
      made.push({ cp, rand, id });
      prev = id;
      onProgress?.(i + 1, RUN_LENGTH, r?.txHash);
    }
  } catch (e) {
    // Leave the holder on their last good run rather than on half a new one.
    Object.assign(ps, saved);
    e.settled = settled;
    throw e;
  }

  const newestFirst = made.slice().reverse();
  // The path is deliberately NOT captured here. Every later anchoring, by this
  // holder or any other, changes the tree root, and a path taken at anchor time
  // stops verifying the moment someone else anchors. Keep the leaf and derive
  // the path against the tree as it stands when a statement is actually made.
  runs[who] = {
    chain: newestFirst.map((m) => m.cp),
    chainRands: newestFirst.map((m) => m.rand),
    leaf: newestFirst[0].id,
  };

  const record = {
    source,
    holder: who,
    receipts: summary.receipts,
    counterparties: summary.counterparties,
    total: summary.total.toString(),
    // What a statement can actually prove. Equal to the total unless the record
    // is longer than one run, in which case the difference has to be visible.
    provenTotal: summary.coveredTotal.toString(),
    provenReceipts: summary.coveredReceipts,
    batches: summary.batches,
    provenBatches: summary.statementCovers,
    entriesOnChain: RUN_LENGTH,
    capacity: STATEMENT_CAPACITY,
    truncated: summary.truncated,
    skipped,
    rows: receipts.map((r, i) => ({
      n: i + 1,
      counterparty: r.counterparty,
      date: r.date,
      anchored: i < summary.coveredReceipts,
    })),
  };
  records[who] = record;
  return { record, summary, batches };
}

// WHO, not every holder defined: only the ones brought up above have a
// contract handle, and seeding one that does not is how this crashed after
// paying for eight anchors on a public network.
if (saved?.runs && WHO.every((w) => saved.runs[w])) {
  // Everything this start needs is already on chain and written down. Anchoring
  // it again would cost the same fees for an identical result.
  restoreRuns(saved);
  console.log(`bridge: restored ${WHO.join(', ')} without re-anchoring`);
} else {
  for (const who of WHO) {
    await anchorRun(who, HOLDERS[who].receipts, {
      source: 'starter',
      onProgress: (i, n) => console.log(`bridge: anchored ${who} entry ${i}/${n}`),
    });
  }
  saveState(dep.address);
  if (RESUME) console.log('bridge: wrote', STATE_FILE, 'so a restart costs nothing');
}

// The verifier derives this off-chain, with no transaction, to bind an ask to
// a named holder. It is a commitment, so it reveals nothing about the secret.
const holderId = (who) => C.pureCircuits.holderIdOf(HOLDERS[who].sk);
const HOLDER_IDS = Object.fromEntries(Object.keys(HOLDERS).map((w) => [hex(holderId(w)), w]));

/**
 * The chain judges expiry by block time, so the UI has to as well. Reading the
 * wall clock instead makes an ask look open for as long as the node lags.
 */
// Block time changes about every six seconds, but `state()` asked the indexer
// for it on every single call, and the app polls `state()` every five. Under
// load that second round trip was half the cost of the endpoint. One second of
// cache is far inside the block interval, so expiry is no less accurate.
let blockTimeCache = { at: 0, value: 0 };
async function chainNowMs() {
  const now = Date.now();
  if (now - blockTimeCache.at < 1000 && blockTimeCache.value) return blockTimeCache.value;
  try {
    const r = await fetch(NET.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height timestamp } }' }),
    });
    const j = await r.json();
    const t = Number(j?.data?.block?.timestamp);
    if (Number.isFinite(t) && t > 0) {
      blockTimeCache = { at: Date.now(), value: t };
      return t;
    }
  } catch { /* fall through to the local clock */ }
  return Date.now();
}

const state = async () => {
  const st = await dep.ledgerState();
  const nowMs = await chainNowMs();
  const requests = [];
  for (const [k, v] of st.requests) {
    const bound = hex(v.holderId) !== hex(ZERO);
    requests.push({
      id: txt(k),
      verifier: txt(v.verifierPk),
      threshold: v.threshold.toString(),
      expiry: v.expiry.toString(),
      open: v.open,
      expired: Number(v.expiry) * 1000 < nowMs,
      boundTo: bound ? (HOLDER_IDS[hex(v.holderId)] ?? 'someone else') : null,
    });
  }
  const verdicts = [];
  for (const [k, v] of st.verdicts) {
    verdicts.push({
      id: hex(k).slice(0, 16),
      met: v.met,
      // A string, like the request threshold beside it: these are minor units
      // and Number() would quietly round anything past 2^53.
      threshold: v.threshold.toString(),
      concentrationOk: v.concentrationOk,
      batches: Number(v.batches),
      receiptCount: Number(v.receiptCount),
      verifier: txt(v.verifierPk),
    });
  }
  return {
    // Which chain this is. The interface used to say "Local Midnight network"
    // whatever it was talking to, so a bridge pointed at preview showed a
    // preview contract under a label claiming it was local. An app that is
    // wrong about which chain it is on is wrong about everything downstream.
    network: NETWORK,
    address: dep.address,
    issued: st.issued.toString(),
    blockTime: nowMs,
    holders: HOLDER_LIST,
    requests,
    verdicts,
  };
};

// Every circuit call reads the single shared `ps` witness object, so two
// overlapping requests would prove from each other's receipts. One queue, so
// writes run strictly one at a time.
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
};
let importing = false;

// This service holds the wallet and the plaintext record. `*` would let any
// page you have open read the record and spend from the wallet.
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5177', 'http://localhost:5177',
  'http://127.0.0.1:5178', 'http://localhost:5178',
]);
const corsFor = (req) => {
  const origin = req?.headers?.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : 'null';
};
const json = (res, code, body, req) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': corsFor(req),
    vary: 'Origin',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
});

/**
 * Three different things fail here and they are not the same news:
 *   - the chain refused the proof, which is the product working;
 *   - the caller sent something the ledger cannot hold;
 *   - the local stack is unreachable, which is an outage.
 * Reporting all three as "rejected" taught people to distrust real rejections.
 */
function classify(e) {
  const m = String(e?.message ?? e);
  const assertion = (m.match(/failed assert: ([^\n"]+)/) || [])[1];
  if (assertion) return { code: 400, body: { error: assertion.trim(), rejected: true } };
  if (e instanceof BadInput) return { code: 400, body: { error: m, rejected: false, badInput: true } };
  return {
    code: 503,
    body: { error: m.split('\n')[0].slice(0, 300), rejected: false, unreachable: true },
  };
}

/**
 * CORS decides what a page may *read*, not what it may *send*. A cross-origin
 * POST is delivered and executed; the browser only withholds the response. So
 * any page the user has open could drive this service: post asks, spend the
 * wallet on an import, publish a statement. Verified by doing it, with
 * `origin: http://evil.example`, and watching the transaction land on chain.
 *
 * A browser always sends Origin on a cross-origin request, so refusing a
 * present-but-unlisted Origin closes that door completely. A missing Origin is
 * a non-browser caller (curl, the test scripts, a local CLI) and is allowed,
 * because it is not the attack this guards against.
 */
const originAllowed = (req) => {
  const origin = req.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {}, req);
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && !originAllowed(req)) {
    return json(res, 403, {
      error: 'this service only accepts writes from the app on this machine',
      rejected: false,
    }, req);
  }
  try {
    if (url.pathname === '/api/state') return json(res, 200, await state(), req);

    if (url.pathname === '/api/record') {
      const who = HOLDERS[url.searchParams.get('as')] ? url.searchParams.get('as') : 'alice';
      return json(res, 200, records[who], req);
    }

    // One statement, by id, for the page a verifier is sent.
    if (url.pathname.startsWith('/api/statement/')) {
      const id = url.pathname.split('/').pop();
      const s = await state();
      const v = s.verdicts.find((x) => x.id === id);
      return v
        ? json(res, 200, { ...v, address: s.address }, req)
        : json(res, 404, { error: 'no statement with that reference' }, req);
    }

    // Import a real record. Each batch is one transaction; a history shorter
    // than a run is filled with empty batches so the run length says nothing
    // about how much history there is.
    if (url.pathname === '/api/import' && req.method === 'POST') {
      if (importing) {
        return json(res, 409, {
          error: 'an import is already running; wait for it to finish',
          rejected: false,
        }, req);
      }
      importing = true;
      const b = await readBody(req);
      const t0 = Date.now();
      try {
        return await serial(async () => {
          const { receipts, skipped } = parseCsv(b.csv ?? '');
          if (!receipts.length) throw new BadInput('no rows in that file could be read as a payment');
          const { record, summary } = await anchorRun('alice', receipts, { source: 'import', skipped });
          return json(res, 200, {
            ms: Date.now() - t0,
            imported: summary.receipts,
            counterparties: summary.counterparties,
            total: summary.total.toString(),
            batches: summary.batches,
            provenBatches: summary.statementCovers,
            entriesOnChain: RUN_LENGTH,
            provenReceipts: summary.coveredReceipts,
            provenTotal: summary.coveredTotal.toString(),
            capacity: STATEMENT_CAPACITY,
            truncated: summary.truncated,
            skipped,
            record,
          }, req);
        });
      } finally {
        importing = false;
      }
    }

    if (url.pathname === '/api/request' && req.method === 'POST') {
      const b = await readBody(req);
      const t0 = Date.now();
      if (b.boundTo && !HOLDERS[b.boundTo]) {
        throw new BadInput(`no holder called ${JSON.stringify(String(b.boundTo))}`);
      }
      const threshold = BigInt(String(b.threshold ?? '0'));
      if (threshold < 0n || threshold >= 2n ** 64n) {
        throw new BadInput('the amount asked for does not fit the ledger field');
      }
      const id = label32(b.id, 'the reference');
      const verifier = label32(b.verifier, 'your name');
      const bind = b.boundTo ? holderId(b.boundTo) : ZERO;
      const ttl = Number(b.ttlSeconds ?? 3600);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new BadInput('the expiry is not a number of seconds');
      const expiry = BigInt(Math.floor((await chainNowMs()) / 1000) + ttl);
      const r = await serial(() => dep.actions.createRequest(id, verifier, bind, threshold, expiry));
      return json(res, 200, { txHash: r.txHash, ms: Date.now() - t0 }, req);
    }

    if (url.pathname === '/api/answer' && req.method === 'POST') {
      const b = await readBody(req);
      const who = HOLDERS[b.as] ? b.as : 'alice';
      const id = label32(b.id, 'the reference');
      const nonce = label32(b.nonce ?? 'n-' + Date.now(), 'the nonce');
      return await serial(async () => {
        const run = runs[who];
        if (!run) throw new BadInput(`no record anchored for ${who}`);
        const ps = states[who];
        const holderDep = deps[who];
        const tree = await holderDep.ledgerState();
        ps.sk = HOLDERS[who].sk;
        ps.chain = run.chain;
        ps.chainRands = run.chainRands;
        ps.path = tree.receipts.findPathForLeaf(run.leaf);
        if (!ps.path) throw new BadInput(`${who}'s newest entry is not on this chain any more`);
        const t0 = Date.now();
        // Snapshot the verdict set first. Ledger Map iteration order is not
        // insertion order, so "the last one in the array" is not "the new one";
        // relying on that silently returns a previous statement's verdict.
        const beforeIds = new Set((await state()).verdicts.map((x) => x.id));
        const r = await holderDep.actions.answerRequest(id, nonce);
        // Never trust the call's return shape for the verdict either. Identify
        // the new row by difference, and say so if it cannot be found.
        const after = await state();
        const v = after.verdicts.find((x) => !beforeIds.has(x.id)) ?? null;
        // It settled either way. A 500 here would tell the user their statement
        // was refused when it is on the chain.
        return json(res, 200, {
          settled: true, txHash: r.txHash, ms: Date.now() - t0, verdict: v, holder: who,
        }, req);
      });
    }

    return json(res, 404, { error: 'not found' }, req);
  } catch (e) {
    const { code, body } = classify(e);
    if (e?.settled !== undefined) body.settledEntries = e.settled;
    return json(res, code, body, req);
  }
}).listen(8790, '127.0.0.1', () => console.log('bridge: listening on http://127.0.0.1:8790'));
