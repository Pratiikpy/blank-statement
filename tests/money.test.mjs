// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The amount field round trip. This exists because it was broken: the field
// echoed a locale-formatted amount back into itself on blur, and in any
// comma-decimal locale that silently changed the number by a factor of a
// thousand.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { money, moneyInput } from '../app/money.mjs';
import { parseAmount } from '../app/import.mjs';

const AMOUNTS = [0n, 1n, 99n, 100n, 12345n, 50000n, 2045099n, 999999999999n, 18446744073709551615n];

describe('an amount survives being written back into the field', () => {
  test('moneyInput round-trips through parseAmount exactly', () => {
    for (const minor of AMOUNTS) {
      assert.equal(parseAmount(moneyInput(minor)), minor, `round trip failed for ${minor}`);
    }
  });

  test('moneyInput never groups and always uses a full stop', () => {
    assert.equal(moneyInput(2045099n), '20450.99');
    assert.equal(moneyInput(1n), '0.01');
    assert.equal(moneyInput(0n), '0.00');
    assert.match(moneyInput(999999999999n), /^\d+\.\d{2}$/);
  });

  test('negatives keep their sign through the round trip', () => {
    assert.equal(moneyInput(-2045099n), '-20450.99');
    assert.equal(parseAmount('-20450.99'), -2045099n);
  });

  test('the localised form is NOT safe to feed back, which is why the two differ', () => {
    // Reproduce a comma-decimal locale rather than trusting the test runner's.
    const g = new Intl.NumberFormat('de-DE');
    const localised = g.format(20450n) + ',' + '99';
    assert.equal(localised, '20.450,99');
    // parseAmount strips commas and expects a full stop, so this reads as 2045.
    assert.equal(parseAmount(localised), 2045n);
    // The canonical form does not have that problem.
    assert.equal(parseAmount(moneyInput(2045099n)), 2045099n);
  });
});

describe('money is for reading', () => {
  test('it carries the sign and two decimal places', () => {
    assert.match(money(2045099n), /20.450.99$/);
    assert.ok(money(2045099n).startsWith('£'));
    assert.ok(money(-100n).startsWith('-£'));
  });

  test('a value it cannot read says so rather than showing NaN', () => {
    assert.equal(money('not a number'), 'not a number');
    assert.doesNotMatch(money(undefined), /NaN|undefined/);
  });
});
