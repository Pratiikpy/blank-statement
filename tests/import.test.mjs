// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, parseCsv, fromEvmTransfers, toBatches, summarise,
  counterpartyId, counterpartyKey, BATCH_SIZE, STATEMENT_CAPACITY,
} from '../app/import.mjs';

describe('amounts', () => {
  test('plain and decimal values become minor units', () => {
    assert.equal(parseAmount('1200'), 120000n);
    assert.equal(parseAmount('1200.50'), 120050n);
    assert.equal(parseAmount('0.07'), 7n);
  });
  test('thousands separators, currency symbols and spaces are tolerated', () => {
    assert.equal(parseAmount(' £1,234.50 '), 123450n);
    assert.equal(parseAmount('$2,000'), 200000n);
  });
  test('more than two decimal places truncates rather than rounding up', () => {
    assert.equal(parseAmount('1.999'), 199n);
  });
  test('a value that is not a number is an error, never a zero', () => {
    assert.throws(() => parseAmount('n/a'), /not an amount/);
    assert.throws(() => parseAmount(''), /not an amount/);
  });
});

describe('reading a CSV', () => {
  const csv = [
    'date,client,amount',
    '2026-01-03,Acme Ltd,1200.00',
    '2026-01-19,Borden Studio,900',
    '2026-02-02,Cadence,1500.75',
  ].join('\n');

  test('rows become receipts', () => {
    const { receipts, skipped } = parseCsv(csv);
    assert.equal(receipts.length, 3);
    assert.equal(skipped.length, 0);
    assert.equal(receipts[0].counterparty, 'Acme Ltd');
    assert.equal(receipts[2].amount, 150075n);
  });

  test('alternative header names are understood', () => {
    const { receipts } = parseCsv('when,payer,gross\n2026-01-01,Acme,10');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].amount, 1000n);
  });

  test('quoted fields containing commas survive', () => {
    const { receipts } = parseCsv('date,client,amount\n2026-01-01,"Acme, Ltd",10');
    assert.equal(receipts[0].counterparty, 'Acme, Ltd');
  });

  test('a file without the columns we need says so', () => {
    assert.throws(() => parseCsv('a,b\n1,2'), /counterparty column/);
  });

  test('bad rows are reported, not silently dropped', () => {
    const { receipts, skipped } = parseCsv(
      'date,client,amount\n2026-01-01,Acme,10\n2026-01-02,Broken,n\\a\n2026-01-03,,50',
    );
    assert.equal(receipts.length, 1);
    assert.equal(skipped.length, 2);
    assert.match(skipped[0].reason, /not an amount/);
    assert.match(skipped[1].reason, /no counterparty/);
  });

  test('an unquoted thousands separator is refused, not misread', () => {
    // 2,400.00 without quotes splits into two cells and would otherwise be read
    // as 2. That understates income silently, which is the one thing an import
    // must never do.
    const csv = ['date,client,amount', '2026-01-08,Acme,2,400.00'].join('\n');
    const { receipts, skipped } = parseCsv(csv);
    assert.equal(receipts.length, 0);
    assert.match(skipped[0].reason, /needs quoting/);
  });

  test('the same amount quoted parses correctly', () => {
    const csv = ['date,client,amount', '2026-01-08,Acme,"2,400.00"'].join('\n');
    const { receipts, skipped } = parseCsv(csv);
    assert.equal(skipped.length, 0);
    assert.equal(receipts[0].amount, 240000n);
  });

  test('payments out are not counted as income', () => {
    const { receipts, skipped } = parseCsv('date,client,amount\n2026-01-01,Rent,-500\n2026-01-02,Acme,10');
    assert.equal(receipts.length, 1);
    assert.equal(skipped[0].reason, 'not a payment received');
  });
});

describe('reading EVM transfers', () => {
  test('token units scale down to minor units', () => {
    const { receipts } = fromEvmTransfers(
      [{ from: '0xabc', value: '1500000', hash: '0x1' }], { decimals: 6 },
    );
    assert.equal(receipts[0].amount, 150n); // 1.5 USDC is 150 cents
  });
  test('dust that rounds to nothing is reported rather than counted', () => {
    const { receipts, skipped } = fromEvmTransfers(
      [{ from: '0xabc', value: '1', hash: '0x2' }], { decimals: 6 },
    );
    assert.equal(receipts.length, 0);
    assert.match(skipped[0].reason, /rounds to nothing/);
  });
});

describe('batching for the circuit', () => {
  const many = (n, name = (i) => 'client-' + i) =>
    Array.from({ length: n }, (_, i) => ({ counterparty: name(i), amount: 100n, date: null }));

  test('a full batch is exactly the circuit width', () => {
    const [b] = toBatches(many(BATCH_SIZE));
    assert.equal(b.amounts.length, BATCH_SIZE);
    assert.equal(b.real, BATCH_SIZE);
  });

  test('a short batch is padded with zero-value placeholders', () => {
    const [b] = toBatches(many(3));
    assert.equal(b.amounts.length, BATCH_SIZE);
    assert.equal(b.real, 3);
    assert.equal(b.total, 300n, 'padding must not change the total');
    assert.equal(b.amounts.filter((a) => a === 0n).length, BATCH_SIZE - 3);
  });

  test('padding placeholders are distinct from each other', () => {
    const [b] = toBatches(many(1));
    const ids = b.counterparties.map((c) => Buffer.from(c).toString('hex'));
    assert.equal(new Set(ids).size, BATCH_SIZE, 'the circuit rejects a repeat inside a batch');
  });

  test('every batch has distinct counterparties, which the circuit requires', () => {
    for (const b of toBatches(many(20))) {
      const ids = b.counterparties.map((c) => Buffer.from(c).toString('hex'));
      assert.equal(new Set(ids).size, BATCH_SIZE);
    }
  });

  test('a repeated client is spread across batches, not dropped', () => {
    // Nine payments, all from the same client. They cannot share a batch.
    const rs = Array.from({ length: 9 }, () => ({ counterparty: 'Acme', amount: 100n, date: null }));
    const batches = toBatches(rs);
    assert.equal(batches.length, 9, 'one per batch, because a batch cannot repeat a name');
    const total = batches.reduce((a, b) => a + b.total, 0n);
    assert.equal(total, 900n, 'nothing may be lost in batching');
  });

  test('nothing is lost: batch totals sum to the input total', () => {
    const rs = many(37).map((r, i) => ({ ...r, amount: BigInt(i + 1) * 10n }));
    const expected = rs.reduce((a, r) => a + r.amount, 0n);
    const got = toBatches(rs).reduce((a, b) => a + b.total, 0n);
    assert.equal(got, expected);
  });

  test('the same counterparty name always gives the same id', () => {
    assert.deepEqual(counterpartyId('Acme Ltd'), counterpartyId('Acme Ltd'));
    assert.notDeepEqual(counterpartyId('Acme Ltd'), counterpartyId('Acme Ltdd'));
  });
});

describe('what the holder is told before anchoring', () => {
  test('the summary counts receipts, clients and anchors honestly', () => {
    const rs = Array.from({ length: 20 }, (_, i) => ({ counterparty: 'c' + i, amount: 100n, date: null }));
    const batches = toBatches(rs);
    const s = summarise(rs, batches);
    assert.equal(s.receipts, 20);
    assert.equal(s.counterparties, 20);
    assert.equal(s.total, 2000n);
    assert.equal(s.anchorsNeeded, batches.length);
    assert.equal(s.truncated, false);
  });

  test('a history longer than one statement says so rather than quietly cutting', () => {
    const rs = Array.from({ length: 100 }, (_, i) => ({ counterparty: 'c' + i, amount: 100n, date: null }));
    const s = summarise(rs, toBatches(rs));
    assert.equal(s.truncated, true, 'more batches than a statement can fold must be surfaced');
    assert.equal(s.statementCovers, 8);
    assert.ok(s.coveredTotal < s.total, 'the covered total is smaller than everything imported');
  });
});

describe('reasons point at the right row', () => {
  test('a blank line does not shift the line numbers that follow', () => {
    const csv = [
      'date,client,amount',
      '',
      '2026-01-01,Acme,100.00',
      '',
      '2026-01-02,Bad,oops',
    ].join('\n');
    const { receipts, skipped } = parseCsv(csv);
    assert.equal(receipts.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].line, 5, 'the bad row is on line 5 of the file the person is looking at');
  });

  test('a quote that never closes is named for what it is', () => {
    const { skipped } = parseCsv('date,client,amount\n2026-01-01,"Runs on,Acme,10.00');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /runs across lines/);
  });
});

describe('counterparty ids', () => {
  test('names sharing a long prefix are different clients', () => {
    // Truncating to 32 bytes made these the same id, and the circuit then
    // rejected the batch as a duplicate counterparty at proving time.
    const a = 'Northwind Trading Company Limited (UK)';
    const b = 'Northwind Trading Company Limited (IE)';
    assert.notEqual(counterpartyKey(a), counterpartyKey(b));
  });

  test('an id is 32 bytes whatever the name', () => {
    for (const n of ['a', 'x'.repeat(500), 'Ünïcödé çlïent Ltd']) {
      assert.equal(counterpartyId(n).length, 32);
    }
  });

  test('two long-prefix clients can share a batch', () => {
    const rs = [
      { counterparty: 'Northwind Trading Company Limited (UK)', amount: 100n, date: null },
      { counterparty: 'Northwind Trading Company Limited (IE)', amount: 200n, date: null },
    ];
    const [batch] = toBatches(rs);
    assert.equal(batch.real, 2, 'both belong in the same batch, not spread across two');
    const ids = new Set(batch.counterparties.map((u) => Buffer.from(u).toString('hex')));
    assert.equal(ids.size, BATCH_SIZE, 'every slot in a batch must carry a distinct id');
  });
});

describe('token decimals', () => {
  test('scaling works in both directions', () => {
    const at = (d) => fromEvmTransfers([{ value: '100', from: 'a', hash: 'h' }], { decimals: d });
    assert.equal(at(0).receipts[0].amount, 10000n, 'a zero-decimal token multiplies up to minor units');
    assert.equal(at(1).receipts[0].amount, 1000n);
    assert.equal(at(2).receipts[0].amount, 100n, 'a two-decimal token is already in minor units');
    // 100 base units of a six-decimal token is a ten-thousandth of a cent.
    assert.equal(at(6).receipts.length, 0);
    assert.match(at(6).skipped[0].reason, /rounds to nothing/);
  });

  test('an eighteen-decimal token scales down correctly', () => {
    const r = fromEvmTransfers([{ value: '1000000000000000000', from: 'a', hash: 'h' }], { decimals: 18 });
    assert.equal(r.receipts[0].amount, 100n, 'one whole token is 100 minor units');
  });

  test('a nonsense decimals value is refused rather than guessed', () => {
    assert.throws(() => fromEvmTransfers([], { decimals: -1 }), /decimals/);
    assert.throws(() => fromEvmTransfers([], { decimals: 1.5 }), /decimals/);
  });
});

describe('what one statement can hold', () => {
  test('capacity is the batch width times the run length', () => {
    assert.equal(STATEMENT_CAPACITY, 64);
  });

  test('the covered figures describe exactly what a statement can prove', () => {
    const rs = Array.from({ length: 100 }, (_, i) => ({ counterparty: 'c' + i, amount: 100n, date: null }));
    const s = summarise(rs, toBatches(rs));
    assert.equal(s.coveredReceipts, STATEMENT_CAPACITY);
    assert.equal(s.coveredTotal, 6400n);
    assert.equal(s.total, 10000n);
  });
});
