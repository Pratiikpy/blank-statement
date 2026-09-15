# blank. statement

Prove one thing about your money without handing over everything else.

A verifier posts an ask ("show me you received at least X"). The holder answers it with a single
sentence backed by their own receipts. The amounts, the counterparties and the total never leave
the holder's machine. The answer is published whether or not the bar was met, so a missing answer
can never be passed off as a yes.

Built on Midnight, ledger 8, Compact toolchain 0.31.1.

| | |
|---|---|
| **Use it** | https://blank-statement.vercel.app |
| **Overview** | [what it is, what is proven, what is not](https://comfortable-goal-205.notion.site/blank-statement-3dc9c0ce787681bca1eaffe7f53b9804) |
| **Proof deck** | https://blank-statement-proof.vercel.app |
| **Contract** | `f040eaea35064ad5e67015efb5e138200c8a771ec884768233590a1291546794` on Midnight preview |

There is no backend. Your wallet signs, your browser proves, and your record stays in your browser.
That is why the live app is a static site: there is nowhere for your receipts to go.

---

## What is actually true right now

A working product with real transactions on a public chain, and some real gaps. Both are listed
here, because a README that only lists the wins is how people get misled.

**Works, verified on Midnight preview** — a public network, fees paid from a real wallet:

- **Nothing is hosted.** The wallet signs and the browser proves. There is no server in the path,
  which is the only arrangement where "your record never leaves this machine" is a fact rather
  than a promise. Verified against the built bundle with no bridge running: `qa:browser-native`.
- A verifier posts an ask; it lands on chain and is publicly readable.
- A holder answers it. The circuit folds a run of eight **batches**, checks the total against a
  threshold it reads *from the ledger* rather than from the caller, verifies the run is anchored,
  burns a single-use nullifier, publishes a verdict, and closes the ask.
- A batch is up to eight receipts reduced to `{ prev, total, count, largest }` and committed.
  Anchoring one is a single transaction however many receipts went in, and because each batch names
  its predecessor, one Merkle proof covers the whole history. A statement spans up to 64 receipts
  (8 batches of 8) for the same proving cost as one batch.
- The published counts are the real ones. A batch declares how many of its eight slots hold a
  receipt, and the circuit checks that claim against the amounts themselves: a counted slot must
  carry money and an uncounted one must not. Padding is invisible in the count, so a run of three
  real receipts publishes `receiptCount: 3`, not 64.
- A statement names the amount it answers. Without that, a 1p proof is character-identical to a
  £250 one, and anyone could answer a trivial ask and forward it as a serious one.
- An ask can be bound to a named holder, and the **contract** enforces it — the refusal reads
  `not the holder this was asked of`, not "unknown user".
- An ask answers once. A second attempt is refused by the contract, not hidden by the interface.
- A truthful claim publishes `met: true`. An overclaim publishes `met: false` and still produces a
  readable artifact, so silence can never be passed off as a yes.
- Fee sponsorship works. A browser wallet holding **zero DUST** generated its own proof and wrote
  to preview, with a relay paying: tx `0453f1241d7d60df917ed711a73299a00fa421f9b576deed9666f9e1dc6bcfc9`.

**Not true yet, and load bearing:**

- **Every receipt is self-declared.** Issuer-signed evidence needs in-circuit signature
  verification, and `jubjubSchnorrVerify` does not exist in toolchain 0.31.1 (verified by
  compiling it: `unbound identifier JubjubSchnorrSignature`). Until that is solved, the artifact is
  honest about counts and concentration but cannot vouch for origin. This is the biggest gap.
- **Answering discloses something.** Six fields reach the chain: `met`, `threshold`,
  `concentrationOk`, `batches`, `receiptCount`, `verifierPk`. Repeated asks at different thresholds
  narrow a total by bisection. That is inherent to answering at all, so it is stated rather than
  hidden behind a claim that nothing is revealed.
- **preprod is unwritten.** Reads and the wallet are verified there; the wallet holds nothing to
  pay with, so no write has been made.
- **Concurrency has a measured ceiling.** Two writes from one wallet land fine. Fifteen stall
  rather than fail — they contend for the same DUST inputs. A busier deployment wants a wallet per
  holder and a timeout on submission.
- **No mainnet.** Testnet is the bar until an external audit.

## What cannot be faked

Every assert in the circuit was forced to fire. None is reachable through the interface, because
the interface builds honest witnesses — so the tests lie to the contract directly.

| The lie | What the chain says |
|---|---|
| Inflate a total inside your own run | `broken checkpoint chain` |
| Swap a blinding value | `broken checkpoint chain` |
| Head the run at a checkpoint that is not the proven leaf | `newest checkpoint is not the anchored one` |
| Prove a checkpoint against a different tree | `checkpoint not in tree` |
| Claim more receipts than the batch holds | `a counted slot holds no receipt` |
| Hide a receipt the batch did not count | `an uncounted slot holds a receipt` |
| Name the same client twice in one batch | `duplicate counterparty` |
| Answer an ask written for someone else | `not the holder this was asked of` |
| Answer the same ask twice | `statement already used` |

Getting `checkpoint not in tree` honestly needs a second contract. Hand-editing the witness only
proves the runtime rejects a malformed object, which is a refusal about the shape of the lie rather
than the lie itself — so the path used is a real one, borrowed from another tree.

Each refusal has a sentence the app shows a person. Before this work, not one had ever been
produced: a message nobody has seen fire is a guess.

## Requirements

- Windows: WSL2 with Ubuntu. The toolchain does not run under native Windows.
- Docker, with the daemon running.
- Node 22 or newer. Check with `bash -lc 'node -v'`, not an interactive shell: if your
  `~/.bash_profile` does not source `~/.bashrc`, non-interactive shells silently get an older Node.
- Compact devtools with toolchain 0.31.1 installed at `~/.local/bin/compact`.

## Run it

**The quickest way is not to run it.** https://blank-statement.vercel.app needs only a Midnight
wallet — it is a static site, and the proving happens in your tab.

To run it yourself against a local chain:

```bash
npm install
npm run stack:up          # node 1.0.0, indexer 4.3.3, proof server 8.1.0
npm run contracts:build   # ~30 s
npm run dev               # app on http://127.0.0.1:5177
```

Connect a wallet, and the app deploys its own contract and takes it from there. Nothing else runs.

To build the same static bundle the live site serves:

```bash
VITE_NETWORK=preview VITE_CONTRACT=f040eaea35064ad5e67015efb5e138200c8a771ec884768233590a1291546794   npm run build
npm run serve:dist        # the build, statically, on :5178
```

`VITE_CONTRACT` matters: without it every visitor deploys their own contract, pays for it, and
lands on a ledger nobody else can read — so a verifier would be sent a statement that does not
exist on the contract they are looking at. `VITE_FEE_RELAY` points at a relay if you want to
sponsor fees.

Each on-chain action takes 15 to 45 seconds. That is proving time, not network time.

`npm run stack:down` when finished.

### The bridge

`npm run bridge` still exists, and is still useful: it seeds four demo holders so the states a
verifier cares about are all reachable without importing anything. It is a **development
convenience only** — it holds a key and does the proving, which is exactly what the product must
not ask of anyone. The app no longer uses it.

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

## Tests

The first needs nothing running and takes seconds, so it can gate a commit:

```bash
npm test                     # 89 tests, no chain, no proving
npm run qa:circuit-asserts   # every assert in the circuit, forced to fire — 21/21
npm run qa:browser-native    # the built bundle, with no server behind it
npm run qa:journey           # ask -> answer -> statement, end to end
npm run qa:adversarial       # expired, twice-answered, someone else's, forged
npm run qa:multiparty        # two holders, isolated browser contexts
npm run qa:chain-truth       # read the ledger directly; do not trust the app
```

Point any of them at a public network with `NETWORK=preview`. On preview they cost real fees, so
they are rationed; `qa:adversarial` (32/32) and `qa:multiparty` (47/47) have both run there.

The circuit suite drives the contract through a `CircuitContext`, so every assertion has a test
that trips it, and one test checks that no receipt amount reaches public state at all.

## Bring your own record

**Your record** takes a CSV from a bank, an invoicing tool, or anywhere else money arrived. It is
parsed in the browser, and the same parser anchors it, so the preview and the anchored
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
contracts/src/statement.compact   5 circuits, 13 asserts, 5 ledger fields
app/src/client.js                 the product, in the browser: no server in the path
app/src/chain.js                  wallet providers, proving against the wallet's proof server
app/src/wallet.js                 what the wallet is doing, in words a person can act on
app/src/App.jsx                   the four screens
app/src/styles.css                design tokens, from the brand kit
app/import.mjs                    CSV into batches the circuit can anchor
app/sha256.mjs                    synchronous SHA-256, so counterparty ids match in both places
app/bridge.mjs                    development only: holds a key and proves. The app does not use it.
proof/index.html                  the proof deck
demo/record.mjs                   records the product being used, against a real chain
scripts/stack.sh                  local ledger-8 stack up/down
scripts/build-contracts.sh        compile, and report the numbers that matter
tests/                            76 files; `npm run` lists the 32 qa: runners
fee-relay/                        reference fee relay, ported from ledger-v7 to ledger-v8
qa-evidence/                      screenshots, findings, and the report behind the numbers
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
