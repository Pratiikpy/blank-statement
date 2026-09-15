// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The Record: turn money that already moved into batches the circuit can anchor.
// Everything here runs on the holder's machine. Nothing in this file talks to a
// chain, and nothing in it should ever send a receipt anywhere.
import { sha256, toHex } from './sha256.mjs';

/** Fixed by the circuit: eight receipts per batch, eight batches per statement. */
export const BATCH_SIZE = 8;
export const RUN_LENGTH = 8;
/** The most receipts one statement can cover. */
export const STATEMENT_CAPACITY = BATCH_SIZE * RUN_LENGTH;

const enc = new TextEncoder();

/**
 * A stable 32-byte id for a counterparty name, so the same client collides and
 * different clients do not. It is a hash rather than the first 32 bytes of the
 * name: truncating made "Northwind Trading Company Limited (UK)" and
 * "Northwind Trading Company Limited (IE)" the same id, which the circuit then
 * rejected as a duplicate counterparty at proving time, two minutes in.
 */
export function counterpartyId(name) {
  return sha256(enc.encode(String(name)));
}

/** The same id as a hex string, for grouping and comparison. */
export const counterpartyKey = (name) => toHex(counterpartyId(name));

/**
 * Amounts are held in minor units as BigInt. "1,234.50" becomes 123450n.
 * Anything that is not a number is a parse error, not a zero, because silently
 * reading a broken row as zero understates someone's income.
 */
export function parseAmount(raw) {
  const t = String(raw).trim().replace(/[,\s]/g, '').replace(/^([-+]?)[£$€]/, '$1');
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`not an amount: ${JSON.stringify(raw)}`);
  const neg = t.startsWith('-');
  const [whole, frac = ''] = t.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return { cells: out.map((s) => s.trim()), unterminated: inQ };
}

const HEADERS = {
  date: ['date', 'when', 'timestamp', 'paid_at', 'created'],
  counterparty: ['counterparty', 'client', 'from', 'payer', 'name', 'description', 'source'],
  amount: ['amount', 'value', 'total', 'gross', 'credit'],
};

function findColumns(header) {
  const lower = header.map((h) => h.toLowerCase());
  const pick = (names) => {
    for (const n of names) { const i = lower.indexOf(n); if (i !== -1) return i; }
    return -1;
  };
  const cols = {
    date: pick(HEADERS.date),
    counterparty: pick(HEADERS.counterparty),
    amount: pick(HEADERS.amount),
  };
  if (cols.counterparty === -1 || cols.amount === -1) {
    throw new Error(
      'the file needs a counterparty column and an amount column; ' +
      `saw: ${header.join(', ')}`,
    );
  }
  return cols;
}

/**
 * Parse a CSV of received payments. Returns receipts plus the rows that were
 * skipped and why, because a silent drop is how an import lies about a total.
 *
 * Line numbers are the ones in the file the person is looking at. Blank lines
 * are ignored for parsing but still counted, or every reason printed after the
 * first gap points at the wrong row.
 */
export function parseCsv(text) {
  const lines = String(text).split(/\r?\n/)
    .map((text, i) => ({ text, n: i + 1 }))
    .filter((l) => l.text.trim() !== '');
  if (lines.length < 2) throw new Error('the file has a header but no rows');
  const header = splitCsvLine(lines[0].text).cells;
  const cols = findColumns(header);

  const receipts = [];
  const skipped = [];
  for (let i = 1; i < lines.length; i++) {
    const { text: line, n } = lines[i];
    const { cells, unterminated } = splitCsvLine(line);
    // A quote that never closes means the value carried a line break, which
    // this reader does not join. Say that, rather than blaming the amount.
    if (unterminated) {
      skipped.push({ line: n, reason: 'a quoted value runs across lines', raw: line });
      continue;
    }
    // A row with more cells than the header almost always means an unquoted
    // comma inside a value, typically a thousands separator in the amount.
    // Reading such a row anyway silently understates income, so refuse it.
    if (cells.length > header.length) {
      skipped.push({
        line: n,
        reason: `row has ${cells.length} fields but the header has ${header.length}; ` +
                'an amount containing a comma needs quoting',
        raw: line,
      });
      continue;
    }
    const who = cells[cols.counterparty] ?? '';
    try {
      const amount = parseAmount(cells[cols.amount]);
      if (amount <= 0n) { skipped.push({ line: n, reason: 'not a payment received', raw: line }); continue; }
      if (!who) { skipped.push({ line: n, reason: 'no counterparty', raw: line }); continue; }
      receipts.push({
        date: cols.date === -1 ? null : cells[cols.date] || null,
        counterparty: who,
        amount,
      });
    } catch (e) {
      skipped.push({ line: n, reason: e.message, raw: line });
    }
  }
  return { receipts, skipped };
}

/**
 * Map EVM token transfers into receipts. Takes already-fetched logs so the
 * fetching stays outside, and so this is testable without a network.
 * `decimals` scales the on-chain integer to minor units in either direction: a
 * six-decimal stablecoin divides by 10^4, a zero-decimal token multiplies by
 * 100. The old code only ever divided, which under-reported such a token by
 * a hundredfold.
 */
export function fromEvmTransfers(transfers, { decimals = 6 } = {}) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) {
    throw new Error(`not a token decimals value: ${decimals}`);
  }
  const receipts = [];
  const skipped = [];
  for (const t of transfers) {
    try {
      const raw = BigInt(t.value);
      const minor = d >= 2 ? raw / 10n ** BigInt(d - 2) : raw * 10n ** BigInt(2 - d);
      if (minor <= 0n) { skipped.push({ tx: t.hash, reason: 'rounds to nothing at this precision' }); continue; }
      receipts.push({ date: t.date ?? null, counterparty: t.from, amount: minor, tx: t.hash });
    } catch (e) {
      skipped.push({ tx: t?.hash ?? null, reason: e.message });
    }
  }
  return { receipts, skipped };
}

/**
 * Group receipts into batches the circuit can anchor.
 *
 * Two constraints come straight from the contract and are enforced here rather
 * than discovered at proving time:
 *   - a batch is exactly BATCH_SIZE receipts, so short batches are padded;
 *   - counterparty ids inside a batch must be distinct, so repeats are spread
 *     across batches instead of being silently dropped.
 * Padding uses zero amounts with unique placeholder counterparties, so it adds
 * nothing to a total and cannot collide. The circuit counts only the real ones,
 * so padding never reaches a published receipt count either.
 */
export function toBatches(receipts, { batchSize = BATCH_SIZE } = {}) {
  const remaining = receipts.map((r) => ({ ...r, key: counterpartyKey(r.counterparty) }));
  const batches = [];

  while (remaining.length) {
    const batch = [];
    const used = new Set();
    for (let i = 0; i < remaining.length && batch.length < batchSize; ) {
      const r = remaining[i];
      if (used.has(r.key)) { i++; continue; }
      used.add(r.key);
      batch.push(r);
      remaining.splice(i, 1);
    }
    if (!batch.length) break; // every remaining receipt shares an id with one already placed
    batches.push(batch);
  }

  return batches.map((batch, bi) => {
    const padded = batch.slice();
    for (let slot = padded.length; slot < batchSize; slot++) {
      padded.push({ date: null, counterparty: `__pad-${bi}-${slot}`, amount: 0n, padding: true });
    }
    return {
      receipts: padded,
      real: batch.length,
      total: batch.reduce((a, r) => a + r.amount, 0n),
      amounts: padded.map((r) => r.amount),
      counterparties: padded.map((r) => counterpartyId(r.counterparty)),
    };
  });
}

/** What the holder is told before anything is anchored. */
export function summarise(receipts, batches) {
  const total = receipts.reduce((a, r) => a + r.amount, 0n);
  const names = new Set(receipts.map((r) => counterpartyKey(r.counterparty)));
  const covered = batches.slice(0, RUN_LENGTH);
  return {
    receipts: receipts.length,
    counterparties: names.size,
    total,
    batches: batches.length,
    anchorsNeeded: batches.length,
    statementCovers: Math.min(batches.length, RUN_LENGTH),
    coveredReceipts: covered.reduce((a, b) => a + b.real, 0),
    coveredTotal: covered.reduce((a, b) => a + b.total, 0n),
    truncated: batches.length > RUN_LENGTH,
  };
}
