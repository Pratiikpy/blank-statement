// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Two ways to write an amount, and they are not interchangeable.
//
// `money` is for reading: it follows the reader's locale, so a German reader
// sees 20.450,99 and a French one sees 20 450,99.
//
// `moneyInput` is for putting a value back into a text field: no grouping, a
// full stop for the decimal, identical in every locale, and exactly what
// `parseAmount` in import.mjs reads back.
//
// They were the same function once. The amount field echoed the localised form
// back into itself on blur, and in a comma-decimal locale that silently changed
// the number: de-DE turned £20,450.99 into "20.450,99", which parsed as £20.45,
// and fr-FR turned it into "20 450,99" and got £2,045,099.00. Off by a thousand
// on the field that says how much money someone has to prove.

const grouped = new Intl.NumberFormat();
const DECIMAL = new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';

const split = (minor) => {
  const n = BigInt(minor ?? 0);
  const neg = n < 0n;
  const a = neg ? -n : n;
  return { neg, whole: a / 100n, cents: String(a % 100n).padStart(2, '0') };
};

/** For display. Grouping and decimal separator follow the reader's locale. */
export function money(minor, sign = '£') {
  let parts;
  try { parts = split(minor); } catch { return 'not a number'; }
  return (parts.neg ? '-' : '') + sign + grouped.format(parts.whole) + DECIMAL + parts.cents;
}

/** For writing back into an input. Canonical, locale-independent, re-readable. */
export function moneyInput(minor) {
  const { neg, whole, cents } = split(minor);
  return (neg ? '-' : '') + whole.toString() + '.' + cents;
}
