# blank. statement

Prove one thing about your money without handing over everything else.

A verifier posts an ask ("show me you received at least X"). The holder answers it with a single
sentence backed by their own receipts. The amounts, the counterparties and the total never leave
the holder's machine. The answer is published whether or not the bar was met, so a missing answer
can never be passed off as a yes.

Built on Midnight, ledger 8, Compact toolchain 0.31.1.

---

## What is actually true right now

This is a working prototype with real transactions on a real chain, and some real gaps. Both are
listed here because a README that only lists the wins is how people get misled.

**Works, verified on chain** (transaction hashes and independent indexer confirmations are in
`../EVIDENCE.md`):

- A verifier posts an ask; it lands on chain and is publicly readable.
- A holder answers it. The circuit folds a run of eight **batches**, checks the total against
  a threshold it reads *from the ledger* rather than from the caller, verifies the run is anchored,
  burns a single-use nullifier, publishes a verdict, and closes the ask.
- A batch is up to eight receipts reduced to `{ prev, total, count, largest }` and committed.
  Anchoring one is a single transaction however many receipts went in, and because each batch names
  its predecessor, one Merkle proof covers the whole history. A statement spans up to 64 receipts
  (8 batches of 8) for the same proving cost as one batch.
- The published counts are the real ones. A batch declares how many of its eight slots hold a
  receipt, and the circuit checks that claim against the amounts themselves: a counted slot must
  carry money and an uncounted one must not. Padding is therefore invisible in the count, and a run
  of three real receipts publishes `receiptCount: 3`, not 64.
- An ask can be bound to a named holder, so nobody else can answer it even with the link.
- An ask answers once. `answerRequest` reinserts the request with `open: false`, so a second
  attempt is refused by the contract rather than hidden by the interface.
- A truthful claim publishes `met: true`. An overclaim publishes `met: false` and still produces a
  readable artifact.
- Replaying a spent statement, answering a closed ask, answering an expired ask, and answering an
  ask that does not exist are each rejected, with four distinct assertion failures.
- The whole flow runs in a browser, desktop and mobile.

**Not true yet, and load bearing:**

- **The bridge holds the key and does the proving.** A real user must hold their own key, and
  proving has to move client side. Until that lands, the privacy claim is about what the *chain*
  learns, not about what your own machine's helper process learns.
- **No public testnet deployment.** A wallet sync against preprod aborted after 6 minutes at
  7.1 GB peak RSS. A browser tab cannot do that. This needs a light-sync path before the product
  can leave the local network.
- **Every receipt is self-declared.** Issuer-signed evidence needs in-circuit signature
  verification, and `jubjubSchnorrVerify` does not exist in toolchain 0.31.1 (verified by
  compiling it: `unbound identifier JubjubSchnorrSignature`). Until that is solved, the artifact is
  honest about counts and concentration but cannot vouch for origin.
- **Fee sponsorship runs, but has never sponsored anything.** The reference relay targeted
  ledger-v7 through wallet-sdk 1.x; it is repinned to the ledger-8 generation, builds, runs, and
  answers `/health`, and the `/balance-finalized-tx` endpoint the client expects was added. It
  still has not added dust to a real transaction, because the SDK only wires `feeRelay` into the
  **browser wallet** path: a seed-based client silently ignores the option and tries to fund
  itself. Testing sponsorship therefore needs Lace. See `fee-relay/`.

## Requirements

- Windows: WSL2 with Ubuntu. The toolchain does not run under native Windows.
- Docker, with the daemon running.
- Node 22 or newer. Check with `bash -lc 'node -v'`, not an interactive shell: if your
  `~/.bash_profile` does not source `~/.bashrc`, non-interactive shells silently get an older Node.
- Compact devtools with toolchain 0.31.1 installed at `~/.local/bin/compact`.

## Run it

```bash
npm install
npm run stack:up          # node 1.0.0, indexer 4.3.3, proof server 8.1.0
npm run contracts:build   # ~30 s
npm run bridge            # deploys, anchors two starter runs (~5 min), then serves :8790
npm run dev               # app on http://127.0.0.1:5177
```

The bridge anchors a run of eight entries for each of the four demo holders before it opens the
port, which takes about thirteen minutes. Until it does, the app shows "Cannot reach the bridge"
and recovers on its own.

The four exist so the states a verifier actually cares about are all reachable from the interface
rather than only from a test:

| holder | record | what it demonstrates |
|---|---|---|
| Alice | 64 receipts, 12 clients, evenly spread | a full history; publishes 64 receipts in 8 batches |
| Mallory | 8 receipts, 4 clients | a thin history; publishes 8 in 2, and fails a large threshold |
| Chidi | 10 receipts, one retainer worth more than all the rest | publishes `concentrationOk: false` |
| Rae | 3 receipts | publishes 3 receipts in 1 batch, not 64 in 8 |

Chidi's client list carries "Northwind Trading Company Limited (UK)" and "...(IE)" on purpose.
Those two names share their first 32 bytes, which is what used to collide when counterparty ids
were truncated rather than hashed, and the circuit would reject the batch as a duplicate
counterparty two minutes into proving. Seeding Chidi at all is the regression test.

Then, in order: **Your record** to import a CSV of payments, **Asking** to post an ask,
**Answering** to answer it, **Statements** to read the result and copy the link.
Each on-chain action takes 15 to 26 seconds, which is proving time, not network time.

`npm run stack:down` when finished.

Tests. The first needs nothing running and takes a few seconds, so it can gate a commit:

```bash
npm test                          # 70 tests, no chain, no proving, ~3.5 s
npm run test:concurrency          # two statements racing on the same ledger slots
npm run test:concurrency:scale    # the same at N writers; N=10 unless you set N
npm run test:gasless              # can an unfunded wallet transact via the relay
```

The circuit suite drives the contract through a `CircuitContext`, so every assertion in the circuit
has a test that trips it, and one test checks that no receipt amount reaches public state at all.
The three probes each deploy their own contract and anchor their own run, so they need the stack up
and cost about two minutes each.

## Bring your own record

**Your record** takes a CSV from a bank, an invoicing tool, or anywhere else money arrived. It is
parsed in the browser, and the same parser runs in the bridge, so the preview and the anchored
result cannot disagree.

- It needs a counterparty column and an amount column. `date`, `client`, `from`, `payer`, `value`,
  `gross` and several other spellings are all understood.
- Rows it cannot read are listed with a reason and a line number, never dropped quietly. An
  unquoted thousands separator is refused rather than misread, because reading `2,400.00` as
  `2` understates income by three orders of magnitude.
- Receipts are grouped into batches of eight distinct counterparties. A repeated client is spread
  across batches instead of being dropped.
- A statement covers 64 receipts. A longer file is imported in full and anchored up to that point,
  and the difference is shown as a number, on the preview and on the record, before and after.

`app/import.mjs` also maps EVM token transfers into the same shape, scaling by the token's
decimals in either direction.

## Two things about running this on Windows

**Work from a WSL-local path if you can.** `npm install` and Vite on `/mnt/c` are slow enough to
be annoying. Cloning into `~/` inside WSL is materially faster.

**Keep line endings LF.** Editing a shell script from the Windows side turns `set -euo pipefail`
into `pipefail`, and WSL bash rejects it with `set: pipefail: invalid option name`. A
`.gitattributes` in this repo pins LF; if you edit these files with a Windows tool, check it.

## Layout

```
contracts/src/statement.compact   3 circuits: anchorCheckpoint, createRequest, answerRequest
app/bridge.mjs                    holds the wallet, proves, exposes the contract over HTTP
app/import.mjs                    CSV and EVM transfers into batches the circuit can anchor
app/sha256.mjs                    synchronous SHA-256, so counterparty ids match in both places
app/src/App.jsx                   the four screens
app/src/styles.css                Blank's design tokens, taken from the brand kit
scripts/stack.sh                  local ledger-8 stack up/down
scripts/build-contracts.sh        compile, and report the numbers that matter
tests/sim.mjs                     drives the compiled contract offline, for both circuit suites
tests/circuits.test.mjs           circuit unit tests, no chain required
tests/chain.test.mjs              batch-chain tests, including five forgery attempts
tests/import.test.mjs             the Record: parsing, batching, and what it refuses
tests/probe.mjs                   shared rig for the probes that need a live chain
tests/concurrency.mjs             do two statements racing on the same ledger slots both land
tests/concurrency-scale.mjs       the same question at N writers (N=10 by default)
tests/gasless.mjs                 can an unfunded wallet transact with the relay paying
fee-relay/                        reference fee relay, ported from ledger-v7 to ledger-v8
```

## Vocabulary

One noun per object, in the interface and here:

- A **receipt** is one payment that arrived.
- A **batch** is up to eight receipts, anchored in one transaction. The contract calls the
  committed form a `Checkpoint`; outside the contract it is a batch.
- A **run** is the eight batches one statement folds.
- An **ask** is what a verifier posts. A **statement** is the answer to one.
- **Import** is what you do to a file. **Anchor** is what the ledger does to a batch.

## Four traps that will cost you an afternoon

**Duplicate on-chain runtime.** `compact-runtime` asks for `onchain-runtime-v3@^3.0.0` and
`midnight-js-protocol` pins `3.0.0` exactly, so npm installs two copies. Two WASM instances means
`instanceof` fails across them, and every circuit call dies with `expected instance of StateValue`
while deploy succeeds and hides the problem. The `overrides` block in `package.json` collapses it
to one copy. Keep it. The same failure appears as
`expected instance of ContractMaintenanceAuthority` if compiled contract bindings are loaded from
a sibling project with its own `node_modules`, which is why the compiled output lives here.

**Never trust a call's return shape for the verdict.** An early version read the verdict off the
SDK call's return value, got `undefined`, and showed the user "Rejected" for a transaction that
had already settled on chain. Read it back from ledger state, and identify the new row by
difference: ledger `Map` iteration order is not insertion order.

**A Merkle path goes stale the moment anyone else anchors.** Capturing `findPathForLeaf` when a run
is anchored and reusing it later fails with `checkpoint not in tree` as soon as another holder
anchors anything, because the root has moved. Keep the leaf and derive the path against the tree as
it stands when the statement is made.

**A bare path is not a module specifier on Windows.** `await import(join(dir, 'index.js'))` reads
`C:` as a URL scheme and throws `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Under `node --test` that surfaces
as a failed `before` hook with the children marked cancelled, so the summary can read `# fail 0`
while half the suite never ran. Use `pathToFileURL(...).href`.

## Compact notes worth knowing

Each of these cost a compile failure to discover and contradicts what the documentation implies:

- `let` is reserved and cannot be used. Accumulate with the standard library `fold`.
- `Cell<T>` is not a writable type name. Declare the ledger type directly and assign with `=`.
- `Field` has no ordering. Comparisons need sized `Uint`.
- Multiplication widens; `largest * 2` can be rejected as unrepresentable. `largest + largest`
  says the same thing and compiles.
- A witness-derived Merkle root must be explicitly `disclose()`d before `checkRoot`.
- Disclosure is marked per value, not per container. Wrapping a struct in `disclose()` is not
  enough; each field that becomes public is disclosed individually, which makes the source state
  exactly what leaves.
- A value that only ever reaches a commitment needs no `disclose()`. `Checkpoint.count` is
  witnessed and hashed into the leaf, so it stays private while still being provable.

## Licence

Apache-2.0 for the Midnight-related code, per the buildathon requirements.
