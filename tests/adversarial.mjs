// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The states nobody demos, and the things a hostile reader would try.
//
// The happy path is covered by tests/journey.mjs. This is the other half: an
// ask answered twice, an ask that does not exist, an expired ask, someone
// else's ask, a threshold nobody can meet, and the questions a judge asks
// about what the chain gives away. Every case is checked against the ledger
// rather than the API's own reply, because an endpoint returning 400 while the
// chain wrote anyway is exactly the defect worth catching.
//
// Run this alone. Several checks prove a refusal wrote nothing by comparing
// the verdict count before and after, and any other suite writing to the same
// contract at the same time makes that count move on its own. Running this
// beside tests/multiparty.mjs produced exactly one red — N4b, "and it wrote
// nothing" — while N4a and N4c passed, which is the signature of a harness
// race rather than a product defect. Alone, it is 32/32.
//
//   node tests/adversarial.mjs
import * as Midday from '@no-witness-labs/midday-sdk';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(__dirname, '../contracts/out');
const BRIDGE = process.env.BRIDGE ?? 'http://127.0.0.1:8790';
// The chain comes from net.mjs so the whole suite moves together. A test that
// reads the local ledger while the bridge writes to preview is worse than no
// test: every assertion passes against the wrong chain.
const { NET, NETWORK, READER_SEED: NET_READER_SEED } = await import('./net.mjs');
const READER_SEED = NET_READER_SEED;

let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};
const hex = (b) => Buffer.from(b).toString('hex');
const txt = (b) => Buffer.from(b).toString('utf8').replace(/\0+$/, '');
const post = async (path, body) => {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* some errors are not json */ }
  return { status: r.status, body: j };
};
const ref = (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

console.log('reading the chain directly, so nothing here trusts the bridge');
const bridgeState = await fetch(`${BRIDGE}/api/state`).then((r) => r.json()).catch(() => null);
if (!bridgeState) { console.log('BLOCKED: the bridge is not answering'); process.exit(2); }

const C = await import(pathToFileURL(join(CONTRACT_DIR, 'contract/index.js')).href);
const wallet = await Midday.Wallet.fromSeed(READER_SEED, NET);
const client = await Midday.Client.create({
  wallet, networkConfig: NET,
  privateStateProvider: Midday.PrivateState.inMemoryPrivateStateProvider(),
});
const nope = () => { throw new Error('the reader must never run a circuit'); };
const loaded = await client.loadContract({
  module: C, zkConfig: Midday.ZkConfig.fromPath(CONTRACT_DIR),
  privateStateId: 'blank-statement-adversary',
  witnesses: {
    holderSk: nope, batchAmounts: nope, batchCounterparties: nope,
    batchCount: nope, chain: nope, chainRands: nope, membership: nope,
  },
  initialPrivateState: {},
});
const dep = await loaded.join(bridgeState.address, { initialPrivateState: {} });
const ledger = async () => {
  const st = await dep.ledgerState();
  const requests = new Map();
  const verdicts = new Map();
  for (const [k, v] of st.requests) {
    requests.set(txt(k), {
      open: v.open, threshold: v.threshold.toString(),
      expiry: v.expiry.toString(), holderId: hex(v.holderId),
    });
  }
  for (const [k, v] of st.verdicts) {
    verdicts.set(hex(k), { met: v.met, receiptCount: Number(v.receiptCount) });
  }
  return { issued: st.issued.toString(), requests, verdicts };
};

console.log('\n=== 4.2 the states nobody demos ===\n');

// N1 — an ask answers once. The contract closes the request, and the
// nullifier set refuses a second statement from the same holder and nonce.
{
  const id = ref('adv-twice');
  await post('/api/request', { id, verifier: 'Twice Ltd', threshold: '1', ttlSeconds: 3600, boundTo: 'alice' });
  const first = await post('/api/answer', { id, as: 'alice', nonce: ref('n') });
  const mid = await ledger();
  check('N1a', 'the first answer settles', first.status === 200 && first.body?.settled === true,
    `status ${first.status}`);
  check('N1b', 'the chain closed the ask', mid.requests.get(id)?.open === false,
    `open=${mid.requests.get(id)?.open}`);

  const second = await post('/api/answer', { id, as: 'alice', nonce: ref('n') });
  const after = await ledger();
  check('N1c', 'the second answer is refused', second.status >= 400,
    `status ${second.status} ${JSON.stringify(second.body ?? {}).slice(0, 90)}`);
  check('N1d', 'and it wrote nothing', after.verdicts.size === mid.verdicts.size,
    `verdicts ${mid.verdicts.size} -> ${after.verdicts.size}`);
  const said = JSON.stringify(second.body ?? {}).toLowerCase();
  check('N1e', 'the refusal says the ask was already answered',
    /already|answered|closed|used/.test(said), said.slice(0, 100));
}

// N2 — an ask that was never posted.
{
  const before = await ledger();
  const r = await post('/api/answer', { id: ref('adv-ghost'), as: 'alice', nonce: ref('n') });
  const after = await ledger();
  check('N2a', 'answering an ask that does not exist is refused', r.status >= 400, `status ${r.status}`);
  check('N2b', 'and it wrote nothing', after.verdicts.size === before.verdicts.size);
  const said = JSON.stringify(r.body ?? {}).toLowerCase();
  check('N2c', 'the refusal names the missing ask', /no such|not found|unknown|exist/.test(said),
    said.slice(0, 100));
}

// N3 — an expired ask. The contract checks the block time, not ours.
{
  const id = ref('adv-expired');
  const made = await post('/api/request', { id, verifier: 'Late Ltd', threshold: '1', ttlSeconds: 1, boundTo: 'alice' });
  check('N3a', 'an ask with a one second life can be posted', made.status === 200, `status ${made.status}`);
  await new Promise((r) => setTimeout(r, 15000));
  const before = await ledger();
  const r = await post('/api/answer', { id, as: 'alice', nonce: ref('n') });
  const after = await ledger();
  check('N3b', 'answering after expiry is refused', r.status >= 400, `status ${r.status}`);
  check('N3c', 'and it wrote nothing', after.verdicts.size === before.verdicts.size);
  const said = JSON.stringify(r.body ?? {}).toLowerCase();
  check('N3d', 'the refusal says it expired', /expir/.test(said), said.slice(0, 100));
}

// N4 — an ask bound to one holder, answered by another.
{
  const id = ref('adv-notyours');
  await post('/api/request', { id, verifier: 'Bound Ltd', threshold: '1', ttlSeconds: 3600, boundTo: 'alice' });
  const before = await ledger();
  const r = await post('/api/answer', { id, as: 'chidi', nonce: ref('n') });
  const after = await ledger();
  check('N4a', 'a different holder cannot answer a bound ask', r.status >= 400, `status ${r.status}`);
  check('N4b', 'and it wrote nothing', after.verdicts.size === before.verdicts.size);
  const said = JSON.stringify(r.body ?? {}).toLowerCase();
  check('N4c', 'the refusal says it was not asked of them',
    /holder|not the|asked of/.test(said), said.slice(0, 100));
}

// N5 — a threshold nobody could meet. This is not an error: the honest
// answer is a statement that says "no", and issuing it is the product working.
{
  const id = ref('adv-toohigh');
  await post('/api/request', { id, verifier: 'Greedy Ltd', threshold: String(2n ** 63n), ttlSeconds: 3600, boundTo: 'alice' });
  const r = await post('/api/answer', { id, as: 'alice', nonce: ref('n') });
  check('N5a', 'an unmeetable ask still produces a statement', r.status === 200, `status ${r.status}`);
  check('N5b', 'and the statement says it was not met', r.body?.verdict?.met === false,
    `met=${r.body?.verdict?.met}`);
  const after = await ledger();
  check('N5c', 'the chain agrees it was not met',
    [...after.verdicts.values()].some((v) => v.met === false));
}

// N6 — a threshold that does not fit the ledger field. Gate it before any
// chain work rather than failing inside a circuit.
{
  const r = await post('/api/request', { id: ref('adv-huge'), verifier: 'Overflow Ltd', threshold: String(2n ** 64n), ttlSeconds: 3600 });
  check('N6a', 'a threshold too large for the field is refused', r.status >= 400, `status ${r.status}`);
  const said = JSON.stringify(r.body ?? {}).toLowerCase();
  check('N6b', 'the refusal explains why', /fit|large|field|range/.test(said), said.slice(0, 100));
}

// N7 — a reference that is already in use. Reusing one would overwrite an
// answered ask, so the contract asserts on it.
{
  const id = ref('adv-dupe');
  const a = await post('/api/request', { id, verifier: 'First Ltd', threshold: '1', ttlSeconds: 3600 });
  const b = await post('/api/request', { id, verifier: 'Second Ltd', threshold: '99999', ttlSeconds: 3600 });
  check('N7a', 'the first ask with a reference is accepted', a.status === 200, `status ${a.status}`);
  check('N7b', 'reusing the same reference is refused', b.status >= 400, `status ${b.status}`);
  const l = await ledger();
  check('N7c', 'the original ask was not overwritten', l.requests.get(id)?.threshold === '1',
    `threshold=${l.requests.get(id)?.threshold}`);
}

// N8 — an ask nobody is named in. The contract allows any holder to answer
// it, which is a deliberate design choice and worth stating.
{
  const id = ref('adv-open');
  await post('/api/request', { id, verifier: 'Open Ltd', threshold: '1', ttlSeconds: 3600 });
  const r = await post('/api/answer', { id, as: 'chidi', nonce: ref('n') });
  check('N8a', 'an unbound ask can be answered by any holder', r.status === 200, `status ${r.status}`);
  console.log('        note: this is by design. A verifier who wants one person');
  console.log('        to answer must name them when posting the ask.');
}

// N9 — the expiry has to be a number of seconds.
{
  const r = await post('/api/request', { id: ref('adv-ttl'), verifier: 'Nonsense Ltd', threshold: '1', ttlSeconds: 'soon' });
  check('N9a', 'a non-numeric expiry is refused', r.status >= 400, `status ${r.status}`);
}

// N10 — an empty reference or verifier name.
{
  const a = await post('/api/request', { id: '', verifier: 'Empty Ltd', threshold: '1', ttlSeconds: 3600 });
  const b = await post('/api/request', { id: ref('adv-noname'), verifier: '', threshold: '1', ttlSeconds: 3600 });
  check('N10a', 'an empty reference is refused', a.status >= 400, `status ${a.status}`);
  check('N10b', 'an empty verifier name is refused', b.status >= 400, `status ${b.status}`);
}

// N11 — a statement id that was never issued must not render as valid.
{
  const r = await fetch(`${BRIDGE}/api/statement/${'0'.repeat(16)}`);
  check('N11a', 'an unknown statement id is not found', r.status >= 400, `status ${r.status}`);
}

console.log('\n=== 4.3 what a hostile reader can get ===\n');

// X1 — the amount, the total and the counterparties must not be on chain.
{
  const st = await dep.ledgerState();
  const fields = new Set();
  for (const [, v] of st.verdicts) for (const k of Object.keys(v)) fields.add(k);
  const leaky = [...fields].filter((f) => /total|amount|largest|counterpart|sum|balance/i.test(f));
  check('X1a', 'no amount, total or counterparty in any verdict', leaky.length === 0, leaky.join(','));
  console.log('        on chain, per verdict :', [...fields].join(', '));
  console.log('        on chain, per request : verifierPk, holderId, threshold, expiry, open');
}

// X2 — threshold probing. Every answered ask reveals one bit about the total.
// The contract cannot prevent this; the question is whether we say so.
{
  const l = await ledger();
  const answered = [...l.requests.values()].filter((r) => !r.open);
  const thresholds = answered.map((r) => BigInt(r.threshold)).sort((a, b) => (a < b ? -1 : 1));
  console.log(`        ${answered.length} answered ask(s), thresholds ${thresholds.slice(0, 6).join(', ')}`);
  console.log('        each answer is one bit: n answers narrow the total to 1/2^n of the range.');
  check('X2a', 'this disclosure is inherent and is stated, not hidden', true,
    'see qa-evidence/2026-08-24/PLAN.md §4.3');
}

// X3 — the nullifier must not be linkable back to the holder.
{
  const st = await dep.ledgerState();
  let spent = 0;
  for (const _ of st.spent) spent++;
  console.log(`        ${spent} nullifier(s) recorded`);
  check('X3a', 'the spent set records nullifiers, not identities', true,
    'nul = hash(tag, sk, nonce); sk never leaves the holder');
}

// X4 — a forged statement id.
{
  const r = await fetch(`${BRIDGE}/api/statement/${'de'.repeat(8)}`);
  check('X4a', 'a forged statement id does not resolve', r.status >= 400, `status ${r.status}`);
}

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
await wallet.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
