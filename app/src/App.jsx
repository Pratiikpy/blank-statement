// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCsv, toBatches, summarise, parseAmount, STATEMENT_CAPACITY } from '../import.mjs';
import { walletStatus, connect as connectWallet } from './wallet.js';
import { money, moneyInput } from '../money.mjs';

const API = 'http://127.0.0.1:8790';

/**
 * Never let a transport failure or a non-JSON body reach a caller as a thrown
 * promise: every screen would have to guard it, and the ones that forgot pinned
 * their button in its busy label forever.
 */
async function call(path, init, timeoutMs) {
  let r;
  // A refused connection rejects quickly, but a half-open socket or a proxy
  // that swallows the request does not reject at all. Without a deadline the
  // poll simply never resolves and the screen sits on "Connecting…" forever,
  // which is the one failure mode that looks like the product is fine.
  const ac = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    r = await fetch(API + path, { ...init, signal: ac.signal });
  } catch {
    return { ok: false, unreachable: true, error: 'Cannot reach the bridge.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body = null;
  try {
    body = await r.json();
  } catch {
    return { ok: false, error: `The bridge answered with something that is not JSON (HTTP ${r.status}).` };
  }
  return { ok: r.ok, status: r.status, ...body };
}

/** Reads are on a 8s leash: they run every five seconds, so a slow one is
 *  already stale. Writes get no deadline, because anchoring a record honestly
 *  takes minutes and cutting it off would leave the chain ahead of the screen. */
const get = (p) => call(p, undefined, 8000);
const post = (p, b) => call(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(b),
});

/* ---------- numbers ---------- */

// money() reads in the visitor's locale; moneyInput() is the canonical form
// that goes back into a text field. See app/money.mjs for why they differ.

const bytesOf = (s) => new TextEncoder().encode(String(s ?? '')).length;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What the chain said, in a sentence someone can act on. The bridge passes the
 * assertion text through unchanged; turning it into advice is this layer's job.
 */
const REFUSALS = {
  'request expired': 'That ask expired. Ask for a new one.',
  'request already answered': 'That ask has already been answered. Each one answers once.',
  'statement already used': 'That statement was already used. Each one answers once.',
  'no such request': 'No ask with that reference.',
  'request id already used': 'That reference is already taken. Pick another one.',
  'not the holder this was asked of': 'That ask was written for someone else.',
  'duplicate counterparty': 'Two receipts in one batch name the same client.',
  'broken checkpoint chain': 'The record does not match what is anchored. Import it again.',
  'newest checkpoint is not the anchored one': 'The record does not match what is anchored. Import it again.',
  'checkpoint not in tree': 'The record does not match what is anchored. Import it again.',
  'a counted slot holds no receipt': 'A batch says it holds more receipts than it does.',
  'an uncounted slot holds a receipt': 'A batch holds a receipt it did not count.',
};

function refusal(r) {
  if (r?.unreachable) return 'Cannot reach the bridge. Run npm run bridge and this page recovers on its own.';
  const raw = String(r?.error ?? 'something went wrong');
  if (REFUSALS[raw]) return REFUSALS[raw];
  if (r?.rejected) return `The chain refused it. The reason it gave: ${raw}`;
  return raw;
}

/* ---------- theme ---------- */

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))];
}

function ThemeButton() {
  const [theme, cycle] = useTheme();
  const label = theme === 'system' ? 'Match system' : theme === 'light' ? 'Light' : 'Dark';
  return (
    <button className="themebtn" onClick={cycle} title={label} aria-label={'Appearance: ' + label}>
      <span aria-hidden="true">{theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}</span>
    </button>
  );
}

/* ---------- routing ---------- */

function useRoute() {
  const read = () => {
    const m = window.location.hash.match(/^#\/s\/([A-Za-z0-9]+)$/);
    return m ? { name: 'statement', id: m[1] } : { name: 'app' };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/* ---------- shared ---------- */

function Wordmark() {
  return <h1 className="brand">blank.<span> statement</span></h1>;
}

function Net({ state, error, loading }) {
  const cls = loading ? ' idle' : error ? ' off' : '';
  // Name the chain the bridge actually reports. This used to read "Local
  // Midnight network" no matter what, so a bridge pointed at preview showed a
  // preview contract under a label saying it was local.
  const named = { undeployed: 'Local Midnight network' };
  const network = state?.network
    ? (named[state.network] ?? `Midnight ${state.network}`)
    : 'Midnight network';
  const text = loading ? 'Connecting…' : error ? 'Not connected' : network;
  return (
    <span className="netpill">
      <span className={'dot' + cls} />
      {text}
      {state?.address && (
        <span className="addr"> · {state.address.slice(0, 10)}…</span>
      )}
    </span>
  );
}

/**
 * The wallet surface. Today it reports honestly and connects; it does not yet
 * move proving off the bridge, and the copy says so rather than implying a
 * connected wallet means the key has moved.
 */
// The pill lives among the header controls, but its explanation needs the full
// width of the header to read as a sentence. They cannot be one element, so the
// state lives here and the header renders the two pieces where each belongs.
function useWallet() {
  const [status, setStatus] = useState(() => walletStatus());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  // An extension injects whenever it likes: after first paint, after the user
  // installs one, after they unlock it. An earlier version of this gave up
  // after eight seconds and then never looked again, so a wallet installed
  // while the page sat open stayed invisible. The check reads two properties,
  // so there is no reason to ever stop: poll slowly, and look immediately
  // whenever the tab regains focus, which is exactly when someone comes back
  // from installing or unlocking.
  useEffect(() => {
    let alive = true;
    const look = () => {
      if (!alive) return;
      const next = walletStatus();
      setStatus((prev) => (prev.state === next.state && prev.message === next.message ? prev : next));
      // A connection is only real while the wallet that granted it is still
      // there. Without this the pill kept showing an address and a live dot
      // after the extension was removed, which is the app lying about its own
      // state, which is the one thing this product cannot do.
      if (next.state !== 'available') setResult(null);
    };
    const t = setInterval(look, 2000);
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, []);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await connectWallet('undeployed');
      setResult(r);
      if (r.ok) setStatus(walletStatus());
    } finally {
      setBusy(false);
    }
  };

  const connected = result?.ok && status.state === 'available';
  const label = connected
    ? (result.address ? result.address.slice(0, 12) + '…' : result.name)
    : status.state === 'available' ? 'Connect wallet'
    : status.state === 'outdated' ? 'Wallet too old'
    : status.state === 'evm-only' ? 'Ethereum wallet only'
    : 'No wallet';

  const title = connected
    ? `${result.name.charAt(0).toUpperCase() + result.name.slice(1)}, connector ${result.apiVersion}. Proving still happens on the bridge.`
    : (result?.message ?? status.message);

  // Anything the label cannot say on its own has to be on the screen, not in a
  // tooltip. A refused connection used to leave the pill reading "Connect
  // wallet" exactly as before: the wallet's own window had opened and closed,
  // and the app looked like it had done nothing at all. A tooltip needs a mouse
  // and a hover, so on a phone that sentence could never be read.
  //
  // Only the cases the label leaves unexplained get a note. "No wallet" already
  // says everything, and a connected pill shows the address, so neither needs
  // repeating underneath.
  //
  // A connected wallet gets one too, but only when its proof server does not
  // belong to the network it is on. That combination is silent everywhere else
  // and turns a write into a five-minute spinner, so it is worth the line.
  const note = result && !result.ok
    ? result.message
    : connected && result.proverWarning ? result.proverWarning
    : status.state === 'evm-only' || status.state === 'outdated' ? status.message : null;

  return {
    status, busy, go, connected, label, title, note,
    failed: !!result && !result.ok,
    // A misconfigured prover is a warning, not a failure: the wallet is
    // connected and everything else works.
    warned: !!(connected && result.proverWarning),
  };
}

function WalletPill({ wallet }) {
  const { status, busy, go, connected, label, title, note, failed } = wallet;
  return (
    <span className="walletpill" title={title}>
      <span className={'dot' + (connected ? '' : failed ? ' off' : status.state === 'available' ? ' idle' : ' off')} />
      {status.state === 'available' && !connected ? (
        <button className="linkbtn" onClick={go} aria-busy={busy}>
          {busy ? 'Connecting…' : 'Connect wallet'}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {/* Only read the sentence out separately when it is not already on the
          page; otherwise a screen reader hears it twice. */}
      {note ? null : <span className="sr-only">{title}</span>}
    </span>
  );
}

/**
 * Sits directly in the header row, not among the controls. The controls size
 * themselves to their content, so a sentence placed among them stretches that
 * group and pushes the whole header onto a second line the moment a wallet has
 * something to say. The header itself is already full width, so a note placed
 * here takes its own line and nothing above it moves.
 */
function WalletNote({ wallet }) {
  if (!wallet.note) return null;
  // A misconfigured proof server is a warning, not a refusal: the wallet is
  // connected and usable. It reads differently so it is not mistaken for one.
  return (
    <p className={'walletnote' + (wallet.warned ? ' warn' : '')} role="status">
      {wallet.warned ? <span aria-hidden="true">⚠ </span> : null}{wallet.note}
    </p>
  );
}

function Refused({ title = 'Refused', children }) {
  if (!children) return null;
  return (
    <div className="callout bad" style={{ marginBottom: 18 }} role="alert">
      <b>{title}</b><span>{children}</span>
    </div>
  );
}

function StatementCard({ v, shareUrl }) {
  const [copied, setCopied] = useState(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied('done');
    } catch {
      // http on anything but localhost has no clipboard. Say so rather than
      // flashing a "Copied" that did not happen.
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 2400);
  };
  return (
    <div className="stmt">
      <div className="verdict">
        <div className={'mark ' + (v.met ? 'ok' : 'no')} aria-hidden="true">{v.met ? '✓' : '✕'}</div>
        {/*
          Name the amount, not just the outcome. Saying only "met the amount
          asked for" made an answer to a penny read identically to an answer to
          a thousand pounds, so a holder could post themselves a trivial ask
          under the verifier's name and pass that link off as the real one. The
          figure comes from the ask, on the chain, so it is the bar that was
          actually set rather than one the holder chose.
        */}
        <div className="claim">
          {v.threshold == null
            ? (v.met ? 'Met the amount asked for.' : 'Did not meet the amount asked for.')
            : (v.met ? `Met ${money(v.threshold)}.` : `Did not meet ${money(v.threshold)}.`)}
        </div>
      </div>
      <p className="sub" style={{ margin: '14px 0 0' }}>
        {v.met
          ? 'Checked against the anchored record. No amount, client or total was revealed.'
          : 'Checked the same way. The answer is published even when it is a no, so a missing answer can never be passed off as a yes.'}
      </p>
      <div className="meta">
        {v.threshold != null && (
          <div><span>Amount asked for</span><b>{money(v.threshold)}</b></div>
        )}
        <div><span>Receipts behind it</span><b>{v.receiptCount}</b></div>
        <div><span>Batches behind it</span><b>{v.batches}</b></div>
        <div>
          <span>Concentration</span>
          <b>{v.concentrationOk ? 'No receipt is worth more than half' : 'One receipt is worth more than half'}</b>
        </div>
        <div><span>Written for</span><b>{v.verifier || 'not named'}</b></div>
        <div><span>Reusable</span><b>No, single use</b></div>
      </div>
      <div className="readers">
        <h3>Who can read this</h3>
        <p>
          The answer is public: it sits on the shared ledger and anyone with the link can read it.
          The record behind it is not. That stays on the holder's machine, and nothing on this page
          can be turned back into it.
        </p>
      </div>
      {shareUrl && (
        <div className="sharebar">
          <code>{shareUrl}</code>
          <button className="btn small" onClick={copy}>
            {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy it by hand' : 'Copy link'}
          </button>
        </div>
      )}
    </div>
  );
}

function WorldSees() {
  // Every field of the on-chain Verdict struct, plus the fact of the row
  // existing. If the contract gains a field, it belongs here the same day.
  const published = [
    ['A statement exists', 'and roughly when'],
    ['Met or not met', 'the single sentence'],
    ['The amount asked for', "the verifier's own figure, not yours"],
    ['Who asked', 'the name on the ask'],
    ['How many receipts', 'the count, never the amounts'],
    ['How many batches', 'how the count was folded'],
    ['Whether one receipt is worth more than half', 'yes or no, no names'],
  ];
  const withheld = [
    ['Every amount', 'each receipt value'],
    ['Every counterparty', 'who paid you'],
    ['Your total', 'what you actually earned'],
  ];
  const group = (rows) => (
    <ul className="rowlist">
      {rows.map(([t, sub]) => (
        <li className="row" key={t}><div><b>{t}</b><small>{sub}</small></div></li>
      ))}
    </ul>
  );
  return (
    <div className="card">
      <h2>What the world sees</h2>
      <p className="sub">
        The whole of what this answer puts on the shared ledger, and the whole of what it does not.
      </p>
      <h3 className="kicker">Published · {published.length}</h3>
      {group(published)}
      <h3 className="kicker withheld">Never leaves the device · {withheld.length}</h3>
      {group(withheld)}
    </div>
  );
}

/* ---------- the page a verifier is sent ---------- */

function StatementPage({ id }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    // Clear both first. Following one share link straight to another left the
    // previous answer's error card sitting above the new statement, because
    // neither piece of state belonged to this id any more.
    setV(null);
    setErr(null);
    get('/api/statement/' + id).then((r) => {
      if (!live) return;
      if (r.ok) setV(r);
      else setErr(r.unreachable ? refusal(r) : 'No statement with that reference.');
    });
    return () => { live = false; };
  }, [id]);
  return (
    <div className="wrap">
      <div className="top">
        <Wordmark />
        <div className="topright">
          <span className="netpill">reference {id}</span>
          <ThemeButton />
        </div>
      </div>
      {err && <div className="card"><h2>No statement here</h2><p className="sub" style={{ margin: 0 }}>{err}</p></div>}
      {!err && !v && <div className="card"><div className="empty">Looking it up…</div></div>}
      {v && (
        <>
          <div className="grid grid-stmt">
            <StatementCard v={v} shareUrl={window.location.href} />
            <WorldSees />
          </div>
          <p className="note">
            Anyone with this link can read the answer. Nobody, including whoever sent it to you,
            can read the record behind it.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- the record ---------- */

const SAMPLE = [
  'date,client,amount',
  '2026-01-08,"Acme Ltd","2,400.00"',
  '2026-01-22,"Borden Studio","1,150.00"',
  '2026-02-05,"Cadence Labs","3,000.00"',
  '2026-02-19,"Acme Ltd","2,400.00"',
  '2026-03-04,"Delta Works","875.50"',
  '2026-03-18,"Eiger Group","1,600.00"',
  '2026-04-01,"Acme Ltd","2,400.00"',
  '2026-04-15,"Fathom","640.25"',
].join('\n');

function SkippedList({ skipped }) {
  if (!skipped?.length) return null;
  return (
    <div className="callout warn" style={{ marginTop: 18 }}>
      <b>{plural(skipped.length, 'row is', 'rows are')} left out</b>
      <ul className="rowlist" style={{ marginTop: 10 }}>
        {skipped.map((s) => (
          <li className="row" key={s.line ?? s.tx}>
            <div><b>Line {s.line}</b><small>{s.reason}</small></div>
          </li>
        ))}
      </ul>
      <span className="note" style={{ marginTop: 6 }}>
        Nothing is dropped quietly. Fix the file and import it again if these should count.
      </span>
    </div>
  );
}

function Record({ record, csv, setCsv, busy, setBusy, result, setResult, log, reload }) {
  const fileRef = useRef(null);

  // Same parser the bridge uses, run here so you see what will happen before
  // committing to a couple of minutes of anchoring.
  const preview = useMemo(() => {
    if (!csv.trim()) return null;
    try {
      const { receipts, skipped } = parseCsv(csv);
      const batches = toBatches(receipts);
      return { ...summarise(receipts, batches), skipped, error: null };
    } catch (e) {
      return { error: e.message };
    }
  }, [csv]);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    try {
      if (f) setCsv(await f.text());
    } catch (err) {
      setResult({ error: `That file could not be read: ${err.message}` });
    } finally {
      // Reset the control, or picking the same file twice fires no change event.
      e.target.value = '';
    }
  };

  const doImport = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    log('Importing. This anchors one entry per batch.');
    try {
      const r = await post('/api/import', { csv });
      if (r.ok) {
        setResult(r);
        log(`Record anchored. ${plural(r.provenReceipts, 'receipt', 'receipts')} in ${plural(r.provenBatches, 'batch', 'batches')} (${Math.round(r.ms / 1000)} s)`);
      } else {
        const msg = refusal(r);
        setResult({ error: msg, settledEntries: r.settledEntries });
        log('Import failed: ' + msg);
      }
    } catch (e) {
      setResult({ error: String(e?.message ?? e) });
      log('Import failed: ' + String(e?.message ?? e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const overflow = preview && !preview.error && preview.truncated;

  return (
    <div className="grid">
      <div className="card">
        <h2>Import your record</h2>
        <p className="sub">
          A CSV from your bank, your invoicing tool, or anywhere else money reached you. It is read
          on this device and never sent anywhere.
        </p>

        <div className="field">
          <label htmlFor="csv">Your payments</label>
          <textarea id="csv" value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder="date,client,amount" spellCheck="false" aria-describedby="csv-help" />
          <p className="help" id="csv-help">
            One row per payment received. It needs a client column and an amount column.
          </p>
        </div>

        <div className="btnrow">
          <label className="btn ghost small filebtn">
            Choose a file
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain"
              onChange={onFile} aria-label="Choose a CSV file of payments" />
          </label>
          <button className="btn ghost small" onClick={() => setCsv(SAMPLE)}>Use a sample</button>
          {csv && (
            <button className="btn ghost small" onClick={() => { setCsv(''); setResult(null); }}>Clear</button>
          )}
        </div>

        {preview?.error && (
          <div className="callout bad" style={{ marginTop: 18 }} role="alert">
            <b>That file cannot be read</b>
            <span>{preview.error}</span>
          </div>
        )}

        {preview && !preview.error && (
          <>
            <div className="statrow">
              <div className="stat"><span>{preview.receipts}</span><small>receipts</small></div>
              <div className="stat"><span>{preview.counterparties}</span><small>clients</small></div>
              <div className="stat"><span>{money(preview.total)}</span><small>total</small></div>
            </div>
            <p className="note">
              {plural(preview.batches, 'batch', 'batches')} of up to eight receipts each, grouped so
              no client appears twice in one batch. One transaction per batch.
            </p>

            <SkippedList skipped={preview.skipped} />

            {overflow && (
              <div className="callout warn" style={{ marginTop: 18 }}>
                <b>One statement covers {STATEMENT_CAPACITY} receipts</b>
                <span>
                  This file holds {preview.receipts}. The first {preview.coveredReceipts}, worth{' '}
                  {money(preview.coveredTotal)}, are what a statement can prove. The rest stay on
                  this device and are not anchored.
                </span>
              </div>
            )}

            <button className="btn" style={{ marginTop: 20 }} onClick={doImport}
              aria-disabled={busy || !preview.receipts} aria-busy={busy}>
              {busy
                ? 'Anchoring… about two minutes'
                : `Anchor ${plural(Math.min(preview.receipts, STATEMENT_CAPACITY), 'receipt', 'receipts')}`}
            </button>
            <p className="note">
              Anchoring writes one entry per batch, padded to {STATEMENT_CAPACITY / 8} entries so the
              length says nothing about how much history there is. Your amounts and clients stay on
              this device; what goes on the ledger is a commitment that cannot be read back.
            </p>
          </>
        )}

        {result?.error && (
          <div className="callout bad" style={{ marginTop: 18 }} role="alert">
            <b>Import failed</b>
            <span>
              {result.error}
              {result.settledEntries > 0 &&
                ` ${plural(result.settledEntries, 'entry', 'entries')} of ${STATEMENT_CAPACITY / 8} reached the chain before it stopped; your record is unchanged.`}
            </span>
          </div>
        )}
        {result && !result.error && (
          <div className="callout" style={{ marginTop: 18 }}>
            <b>Anchored</b>
            <span>
              {plural(result.provenReceipts, 'receipt', 'receipts')} in{' '}
              {plural(result.provenBatches, 'batch', 'batches')}, padded to {result.entriesOnChain}{' '}
              entries on chain, {Math.round(result.ms / 1000)} seconds.
              {result.truncated &&
                ` ${result.imported - result.provenReceipts} receipts were past what one statement covers and were not anchored.`}
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Your record</h2>
        <p className="sub">
          {record?.source === 'import'
            ? 'Imported on this device. Amounts are blacked out to show what leaves. The names are here because they never do.'
            : 'A starter record, until you import your own. Amounts are blacked out the same way.'}
        </p>

        {!record && <div className="empty">Loading…</div>}

        {record && (
          <>
            <div className="statrow">
              <div className="stat"><span>{record.receipts}</span><small>receipts</small></div>
              <div className="stat"><span>{record.counterparties}</span><small>clients</small></div>
              <div className="stat"><span className="redact" aria-hidden="true">{money(record.total)}</span>
                <span className="sr-only">total hidden</span><small>total</small></div>
            </div>
            <p className="note">
              {plural(record.provenBatches, 'batch', 'batches')} anchored
              {record.provenBatches < record.entriesOnChain
                ? `, padded to ${record.entriesOnChain} entries on chain so the length says nothing about how much history there is.`
                : ', which is what one statement folds.'}
            </p>

            {record.truncated && (
              <div className="callout warn" style={{ marginTop: 18 }}>
                <b>Only part of this record can be proven</b>
                <span>
                  A statement covers {record.capacity} receipts. {record.provenReceipts} of{' '}
                  {record.receipts} are anchored, and a statement made now speaks for those.
                </span>
              </div>
            )}

            <SkippedList skipped={record.skipped} />

            <ul className="rowlist" style={{ marginTop: 18 }}>
              {record.rows.slice(0, 12).map((r) => (
                <li className="row" key={r.n}>
                  <div>
                    <b title={r.counterparty ?? undefined}>{r.counterparty ?? `Receipt ${r.n}`}</b>
                    <small>{r.date ? r.date + ' · ' : ''}{r.anchored ? 'anchored' : 'not anchored'}</small>
                  </div>
                  <span className="redact" aria-hidden="true">0000</span>
                  <span className="sr-only">amount hidden</span>
                </li>
              ))}
            </ul>
            {record.rows.length > 12 && (
              <p className="note">and {record.rows.length - 12} more, held on this device</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- asking ---------- */

function Verifier({ state, ask, setAsk, reload, log }) {
  // The form lives in App, not here.
  //
  // Tabs are conditionally rendered, so switching to another one unmounts this
  // component and takes its state with it. Held locally, everything typed was
  // lost on a tab switch and the reference regenerated, which means someone who
  // noted their reference and stepped away to check their record came back to a
  // different one. The record tab already lifts its CSV for exactly this
  // reason; this now matches it.
  const { id, who, amount, boundTo } = ask;
  const setField = (k) => (v) => setAsk((a) => ({ ...a, [k]: v }));
  const setId = setField('id');
  const setWho = setField('who');
  const setAmount = setField('amount');
  const setBoundTo = setField('boundTo');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const parsed = useMemo(() => {
    try {
      const minor = parseAmount(amount);
      if (minor <= 0n) return { error: 'The amount has to be more than nothing.' };
      if (minor >= 2n ** 64n) return { error: 'That amount is larger than the ledger field.' };
      return { minor };
    } catch {
      return { error: 'That is not an amount. Try 20,000.00' };
    }
  }, [amount]);

  const idBytes = bytesOf(id);
  const whoBytes = bytesOf(who);
  const tooLong = idBytes > 32 || whoBytes > 32;
  const blocked = busy || !!parsed.error || tooLong || !id.trim() || !who.trim();

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post('/api/request', {
        id, verifier: who, threshold: parsed.minor.toString(),
        ttlSeconds: 3600, boundTo: boundTo || null,
      });
      if (r.ok) {
        log(`Ask posted. ${r.txHash} (${Math.round(r.ms / 1000)} s)`);
        // A fresh reference for the next ask; the name and amount stay, because
        // a verifier usually posts several asks on the same terms.
        setId('req-' + Math.random().toString(36).slice(2, 7));
      } else {
        const m = refusal(r);
        setErr(m);
        log('Ask refused: ' + m);
      }
    } catch (e) {
      const m = String(e?.message ?? e);
      setErr(m);
      log('Ask failed: ' + m);
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>Ask someone to show their income</h2>
        <p className="sub">
          You choose what they have to show. They never send you their bank history, their client
          list, or a single amount.
        </p>

        <div className="field">
          <label htmlFor="who">Your name</label>
          <input id="who" value={who} onChange={(e) => setWho(e.target.value)}
            aria-describedby="who-help" aria-invalid={whoBytes > 32} />
          <p className="help" id="who-help">
            Appears on their answer.{' '}
            <span className={'counter' + (whoBytes > 32 ? ' over' : '')}>{whoBytes}/32 bytes</span>
          </p>
        </div>

        <div className="field">
          <label htmlFor="amt">Minimum received (£)</label>
          <div className="prefixed">
            <span className="prefix" aria-hidden="true">£</span>
            <input id="amt" value={amount} inputMode="decimal" aria-describedby="amt-help"
              aria-invalid={!!parsed.error}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
              onBlur={() => { if (!parsed.error) setAmount(moneyInput(parsed.minor)); }} />
          </div>
          <p className="help" id="amt-help">
            {parsed.error
              ? parsed.error
              : `What they have to show they received in total, in pounds. Reads as ${money(parsed.minor)}.`}
          </p>
        </div>

        <div className="field">
          <label htmlFor="bind">Who may answer</label>
          <select id="bind" value={boundTo} onChange={(e) => setBoundTo(e.target.value)}>
            <option value="">Anyone holding the link</option>
            {(state?.holders ?? []).map((h) => (
              <option key={h.id} value={h.id}>Only {h.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ref">Reference</label>
          <input id="ref" value={id} onChange={(e) => setId(e.target.value)} maxLength={64}
            aria-describedby="ref-help" aria-invalid={idBytes > 32} />
          <p className="help" id="ref-help">
            How you will recognise this ask later.{' '}
            <span className={'counter' + (idBytes > 32 ? ' over' : '')}>{idBytes}/32 bytes</span>
          </p>
        </div>

        <Refused title="Refused">{err}</Refused>

        <button className="btn" onClick={submit} aria-disabled={blocked} aria-busy={busy}>
          {busy ? 'Posting the ask…' : 'Post the ask'}
        </button>
        <p className="note">
          Expires in one hour. It can be answered once: the contract closes it when the answer
          lands. Binding it to a person means nobody else can answer it, even with the link.
        </p>
      </div>

      <div className="card">
        <h2>Open asks</h2>
        <p className="sub">
          Anyone can read these. The answers are public too. What sits behind an answer is not.
        </p>
        {!state && <div className="empty">Loading…</div>}
        {state && !state.requests?.length && <div className="empty">Nothing asked yet.</div>}
        <ul className="rowlist">
          {state?.requests?.map((r) => {
            const status = !r.open ? ['ok', 'answered'] : r.expired ? ['warn', 'expired'] : ['info', 'open'];
            return (
              <li className="row" key={r.id}>
                <div>
                  <b>{r.id}</b>
                  <small>
                    {r.verifier} · at least {money(r.threshold)}
                    {r.boundTo ? ' · only ' + r.boundTo : ''}
                  </small>
                </div>
                <span className={'badge ' + status[0]}>{status[1]}</span>
              </li>
            );
          })}
        </ul>
        {state?.address && (
          <p className="note">Contract {state.address.slice(0, 18)}… on the local network.</p>
        )}
      </div>
    </div>
  );
}

/* ---------- answering ---------- */

function Holder({ state, record, as, setAs, reload, log, onAnswered }) {
  const holderLabel = (state?.holders ?? []).find((h) => h.id === as)?.label ?? as;
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // An ask is answerable only while it is open and unexpired. Reconcile the
  // selection against every poll, or the dropdown shows one ask and the button
  // submits another.
  const open = useMemo(
    () => (state?.requests ?? []).filter((r) => r.open && !r.expired),
    [state],
  );
  useEffect(() => {
    if (!open.some((r) => r.id === id)) setId(open[0]?.id ?? '');
  }, [open, id]);

  const chosen = open.find((r) => r.id === id);

  const answer = async () => {
    if (busy || !chosen) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post('/api/answer', {
        id, nonce: 'n-' + Math.random().toString(36).slice(2, 9), as,
      });
      if (r.ok && r.verdict) {
        log(`Answer sent. ${r.txHash} (${Math.round(r.ms / 1000)} s)`);
        onAnswered(r.verdict);
      } else if (r.ok) {
        // It settled; the verdict just has not surfaced through the indexer yet.
        const m = 'The statement settled but its verdict has not surfaced yet. It will appear in Statements.';
        setErr(m);
        log(`${m} ${r.txHash ?? ''}`);
      } else {
        const m = refusal(r);
        setErr(m);
        log('Answer refused: ' + m);
      }
    } catch (e) {
      const m = String(e?.message ?? e);
      setErr(m);
      log('Answer failed: ' + m);
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>Answer an ask</h2>
        <p className="sub">
          The terms come from the ask itself, so you cannot quietly lower the bar you are judged
          against.
        </p>

        <div className="field">
          <label htmlFor="as">Answering as</label>
          <select id="as" value={as} onChange={(e) => setAs(e.target.value)}>
            {(state?.holders ?? []).map((h) => (
              <option key={h.id} value={h.id}>{h.label} · {h.note}</option>
            ))}
          </select>
          <p className="help">Each holder answers from their own record, shown on the right.</p>
        </div>

        <div className="field">
          <label htmlFor="ask">Which ask</label>
          <select id="ask" value={id} onChange={(e) => setId(e.target.value)}>
            {!open.length && <option value="">Nothing to answer yet</option>}
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · at least {money(r.threshold)}{r.boundTo ? ' (only ' + r.boundTo + ')' : ''}
              </option>
            ))}
          </select>
        </div>

        {chosen && (
          <div className="callout" style={{ marginBottom: 18 }}>
            <b>What this will publish</b>
            <span>
              Whether you cleared {money(chosen.threshold)}, whether one receipt is worth more than
              half the total, how many receipts and batches stood behind it, and the name on the
              ask. Nothing else.
            </span>
          </div>
        )}

        <Refused title="Refused">{err}</Refused>

        <button className="btn" onClick={answer} aria-disabled={busy || !chosen} aria-busy={busy}>
          {busy ? 'Working… about 20 seconds' : 'Answer it'}
        </button>
        <p className="note">Answer a bound ask as the wrong person and the chain refuses it.</p>
      </div>

      <div className="card">
        <h2>What you are answering from</h2>
        <p className="sub">{holderLabel}'s record, on this device. It never leaves.</p>
        {!record && <div className="empty">Loading…</div>}
        {record && (
          <>
            <div className="statrow">
              <div className="stat"><span>{record.provenReceipts}</span><small>receipts</small></div>
              <div className="stat"><span>{record.counterparties}</span><small>clients</small></div>
              <div className="stat"><span className="redact" aria-hidden="true">{money(record.total)}</span>
                <span className="sr-only">total hidden</span><small>total</small></div>
            </div>
            <p className="note">
              {record.provenReceipts === record.receipts
                ? 'All of it is anchored, so a statement speaks for the whole record.'
                : `${record.provenReceipts} of ${record.receipts} receipts are anchored. A statement speaks for those.`}
              {' '}
              {record.source === 'import'
                ? 'Imported by you. Import a different file any time from Your record.'
                : 'This is the starter record. Import your own from Your record.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- statements ---------- */

function Statements({ state, onOpen }) {
  const list = state?.verdicts ?? [];
  return (
    <div className="card">
      <h2>Statements you have made</h2>
      <p className="sub">
        Each one answers a single ask and cannot be reused. Send the link, not the record.
      </p>
      {!state && <div className="empty">Loading…</div>}
      {state && !list.length && <div className="empty">None yet. Answer an ask to make one.</div>}
      <ul className="rowlist">
        {list.map((v) => (
          <li className="row" key={v.id}>
            <div>
              {/*
                Name the amount here too. A holder with several statements sees
                a column of "Met the amount" that says nothing about which ask
                each one answered, and picking the wrong link to send is the
                same mistake as the one the statement page used to invite.
              */}
              <b>
                {v.threshold == null
                  ? (v.met ? 'Met the amount' : 'Did not meet the amount')
                  : (v.met ? `Met ${money(v.threshold)}` : `Did not meet ${money(v.threshold)}`)}
              </b>
              <small>
                for {v.verifier || 'no one'} · {plural(v.receiptCount, 'receipt', 'receipts')} · {v.id}
              </small>
            </div>
            <div className="btnrow">
              <span className={'badge ' + (v.met ? 'ok' : 'no')}>{v.met ? 'yes' : 'no'}</span>
              <button className="btn ghost small" onClick={() => onOpen(v)}
                aria-label={`Open statement ${v.id} for ${v.verifier || 'no one'}`}>
                Open
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- app ---------- */

const TABS = [
  ['record', 'Your record'],
  ['verifier', 'Asking'],
  ['holder', 'Answering'],
  ['statements', 'Statements'],
];

export default function App() {
  const route = useRoute();
  const [tab, setTab] = useState('record');
  const [state, setState] = useState(null);
  const [record, setRecord] = useState(null);
  const [as, setAs] = useState('alice');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState(null);
  const tabRefs = useRef({});

  // The import screen's work outlives a tab switch, so its state lives here.
  // Unmounting it mid-import lost the progress and let a second one start.
  // The ask form. Lifted here so it survives a tab switch, the same way the
  // CSV below does; the reference is generated once per session rather than on
  // every remount.
  const [ask, setAsk] = useState(() => ({
    id: 'req-' + Math.random().toString(36).slice(2, 7),
    who: 'acme-studio',
    amount: '20,000.00',
    boundTo: '',
  }));
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const reload = useCallback(async () => {
    const [s, r] = await Promise.all([get('/api/state'), get('/api/record?as=' + as)]);
    setLoading(false);
    // A failed poll must not blank the screen: keep whatever was last known
    // good and say what is wrong alongside it.
    if (!s.ok || !r.ok) {
      setError(refusal(s.ok ? r : s));
      return;
    }
    setState(s);
    setRecord(r);
    setError(null);
  }, [as]);

  useEffect(() => {
    if (route.name !== 'app') return;
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload, route.name]);

  const log = useCallback((m) => {
    setStatus(m);
    setLines((l) => [new Date().toLocaleTimeString() + '  ' + m, ...l].slice(0, 40));
  }, []);

  const onTabKey = (e, i) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const k = TABS[(next + TABS.length) % TABS.length][0];
    setTab(k);
    tabRefs.current[k]?.focus();
  };

  // Called before the statement route returns early: a hook that runs on one
  // route and not the other changes the hook count between renders.
  const wallet = useWallet();

  if (route.name === 'statement') return <StatementPage id={route.id} />;

  // Never guess a "newest": ledger map order is not insertion order, so the
  // featured card is only ever a statement this session opened or made.
  const shown = verdict;
  const shareUrl = shown ? window.location.origin + '/#/s/' + shown.id : '';

  return (
    <div className="wrap">
      <div className="top">
        <Wordmark />
        <div className="topright">
          <Net state={state} error={error} loading={loading && !state} />
          <WalletPill wallet={wallet} />
          <ThemeButton />
        </div>
        <WalletNote wallet={wallet} />
      </div>

      <div className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(([k, label], i) => (
          <button
            key={k}
            id={'tab-' + k}
            ref={(el) => { tabRefs.current[k] = el; }}
            className="tab"
            role="tab"
            aria-selected={tab === k}
            aria-controls={'panel-' + k}
            tabIndex={tab === k ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, i)}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 20 }} role="alert">
          <h2>Cannot reach the bridge</h2>
          <p className="sub" style={{ margin: 0 }}>
            Run <code>npm run bridge</code>. This page recovers on its own.
          </p>
        </div>
      )}

      <div className="panel" role="tabpanel" id={'panel-' + tab} aria-labelledby={'tab-' + tab} tabIndex={0}>
        {tab === 'record' && (
          <Record record={record} csv={csv} setCsv={setCsv} busy={importing} setBusy={setImporting}
            result={importResult} setResult={setImportResult} log={log} reload={reload} />
        )}
        {tab === 'verifier' && (
          <Verifier state={state} ask={ask} setAsk={setAsk} reload={reload} log={log} />
        )}
        {tab === 'holder' && (
          <Holder state={state} record={record} as={as} setAs={setAs} reload={reload} log={log}
            onAnswered={(v) => { setVerdict(v); setTab('statements'); }} />
        )}
        {tab === 'statements' && (
          shown
            ? (
              <>
                <div className="grid grid-stmt">
                  <StatementCard v={shown} shareUrl={shareUrl} />
                  <WorldSees />
                </div>
                <div style={{ marginTop: 20 }}>
                  <Statements state={state} onOpen={setVerdict} />
                </div>
              </>
            )
            : <Statements state={state} onOpen={setVerdict} />
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">{status}</p>
      {!!lines.length && (
        <div className="log" tabIndex={0} role="log" aria-label="Activity">{lines.join('\n')}</div>
      )}
    </div>
  );
}
