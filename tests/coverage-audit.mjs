// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// "Is QA done?" as a gate rather than a vibe (QA_MASTER_GUIDE Part 9).
//
// Enumerates the tuples the coverage contract claims, checks each one against
// evidence that actually exists on disk or can be re-derived by running
// something, and exits non-zero on any gap. Prose in a report can drift from
// reality; this cannot, because it fails.
//
//   node tests/coverage-audit.mjs
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/mnt/c/Users/prate/downloads/mid';
const EV = join(ROOT, 'qa-evidence/2026-08-21');
const PROJ = join(ROOT, 'blank-statement');

const rows = [];
const gap = (area, what, why) => rows.push({ ok: false, area, what, why });
const ok = (area, what, note = '') => rows.push({ ok: true, area, what, note });

const shot = (rel) => {
  const p = join(EV, rel);
  if (!existsSync(p)) return null;
  const s = statSync(p);
  return s.size > 2000 ? s.size : null; // a 0-byte or stub png is not evidence
};

// ---------- 1. the statement route, every combination ----------
for (const engine of ['chromium', 'firefox']) {
  for (const vp of ['desktop', 'mobile']) {
    for (const theme of ['light', 'dark']) {
      for (const outcome of ['met', 'notmet']) {
        const rel = `statement/${engine}-${vp}-${theme}-${outcome}.png`;
        const size = shot(rel);
        if (size) ok('statement route', `${engine}/${vp}/${theme}/${outcome}`, `${Math.round(size / 1024)} KB`);
        else gap('statement route', `${engine}/${vp}/${theme}/${outcome}`, 'no screenshot on disk');
      }
    }
  }
}

// ---------- 2. the four app screens, both themes, both viewports ----------
for (const vp of ['desktop', 'mobile']) {
  for (const theme of ['light', 'dark']) {
    for (const screen of ['your-record', 'asking', 'answering', 'statements']) {
      const rel = `firefox/${vp}-${theme}-${screen}.png`;
      const size = shot(rel);
      if (size) ok('app screens (firefox)', `${vp}/${theme}/${screen}`, `${Math.round(size / 1024)} KB`);
      else gap('app screens (firefox)', `${vp}/${theme}/${screen}`, 'no screenshot on disk');
    }
  }
}

// ---------- 3. device profiles with real touch ----------
for (const d of ['iphone-13', 'pixel-7', 'ipad-mini']) {
  const size = shot(`device-${d}.png`);
  if (size) ok('device profiles', d, `${Math.round(size / 1024)} KB`);
  else gap('device profiles', d, 'no screenshot on disk');
}

// ---------- 4. the wallet question, answered with real extensions ----------
// Two wallets, because they answer two different questions. Rabby proves the
// app refuses an Ethereum wallet for the right reason; Lace proves it accepts a
// real Midnight one, and that the refusal a first-time visitor sees is legible.
if (shot('rabby-installed-app-response.png')) ok('wallet', 'real Rabby loaded, app response captured');
else gap('wallet', 'real Rabby', 'no screenshot of the app with Rabby installed');

if (shot('lace-detected.png')) ok('wallet', 'real Lace loaded, connector detected');
else gap('wallet', 'real Lace', 'no screenshot of the app with Lace installed');

if (shot('lace-connect-result.png')) ok('wallet', 'Lace connect attempted, outcome captured');
else gap('wallet', 'Lace connect', 'no screenshot of the app after a connect attempt');

for (const s of ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark']) {
  if (shot(`lace-note-${s}.png`)) ok('wallet', `refusal is readable, ${s}`);
  else gap('wallet', `refusal ${s}`, 'no screenshot of the refusal in that state');
}

// ---------- 4b. the core journey, driven through the interface ----------
// Rendering proves the app draws; only this proves it still does anything. A
// refactor can leave every screen pixel-perfect and every write disconnected.
for (const [file, what] of [
  ['journey-1-asked.png', 'an ask posted through the UI'],
  ['journey-2-answered.png', 'answered by a holder through the UI'],
  ['journey-3-statements.png', 'the statement listed'],
  ['journey-4-statement.png', 'the share link read as a stranger'],
]) {
  if (shot(file)) ok('journey', what);
  else gap('journey', what, `no ${file} on disk`);
}

// ---------- 5. every circuit assertion has a test that trips it ----------
{
  const src = execFileSync('grep', ['-oE', '"[a-z][a-z ]+"', join(PROJ, 'contracts/src/statement.compact')])
    .toString().split('\n').map((l) => l.replace(/"/g, '').trim()).filter(Boolean);
  const asserts = [...new Set(src)];
  const suites = ['tests/circuits.test.mjs', 'tests/chain.test.mjs']
    .map((f) => execFileSync('cat', [join(PROJ, f)]).toString()).join('\n');
  let missing = 0;
  for (const a of asserts) if (!suites.includes(a)) { gap('circuit asserts', a, 'no test trips it'); missing++; }
  if (!missing) ok('circuit asserts', `all ${asserts.length} have a test that trips them`);
}

// ---------- 6. the offline suite actually passes ----------
{
  let out = '';
  try {
    out = execFileSync('node', ['--test', 'tests/circuits.test.mjs', 'tests/chain.test.mjs',
      'tests/import.test.mjs', 'tests/money.test.mjs'], { cwd: PROJ }).toString();
  } catch (e) { out = (e.stdout ?? '').toString() + (e.stderr ?? '').toString(); }
  const pass = /# pass (\d+)/.exec(out)?.[1];
  const fail = /# fail (\d+)/.exec(out)?.[1];
  if (fail === '0' && Number(pass) > 0) ok('offline suite', `${pass} tests pass, 0 fail`);
  else gap('offline suite', 'node --test', `pass=${pass} fail=${fail}`);
}

// ---------- 7. the written contract lists its own gaps ----------
{
  const cov = join(EV, 'COVERAGE.md');
  if (!existsSync(cov)) gap('coverage doc', 'COVERAGE.md', 'missing');
  else {
    const text = execFileSync('cat', [cov]).toString();
    if (/NOT COVERED/.test(text)) ok('coverage doc', 'names its own gaps rather than claiming completeness');
    else gap('coverage doc', 'gap section', 'a report with no stated gaps is the wrong shape');
  }
}

// ---------- report ----------
const gaps = rows.filter((r) => !r.ok);
const byArea = {};
for (const r of rows) (byArea[r.area] ??= []).push(r);

console.log('\ncoverage audit\n');
for (const [area, list] of Object.entries(byArea)) {
  const bad = list.filter((r) => !r.ok).length;
  console.log(`  ${bad ? 'GAP ' : 'ok  '} ${area.padEnd(24)} ${list.length - bad}/${list.length}`);
  for (const r of list.filter((x) => !x.ok)) console.log(`        missing: ${r.what} — ${r.why}`);
}
console.log(`\n  ${rows.length - gaps.length}/${rows.length} checks satisfied`);

// Gaps that are known and externally blocked are listed, not failed: they are
// in COVERAGE.md §6 with an unblock action, which is the honest state for
// something that needs hardware or a password this machine does not have.
console.log('\n  known external blockers (not failures, see COVERAGE.md section 6):');
// The wallet-write entry used to sit here claiming no Lace build both offers
// the local network and returns a signed result. That was wrong, and it was
// wrong for a whole session: Settings > Network does offer Midnight
// "Undeployed", and a browser write now lands through it. Removed rather than
// softened, because a stale blocker reads as a fact.
for (const b of ['a physical handset', 'a real screen reader',
                 'the app UI itself still writes through app/bridge.mjs; the browser wallet path is proven in app/wallet-write.html (tests/wallet-write-relay.mjs) but not yet wired into App.jsx',
                 'preview and preprod writes (the fee relay is funded from local genesis, so it can only pay fees on the local chain)',
                 'public deployment']) console.log('    - ' + b);

if (gaps.length) {
  console.log(`\nFAIL: ${gaps.length} gap(s) in what this repo claims to have covered.`);
  process.exit(1);
}
console.log('\nPASS: every claimed tuple has evidence behind it.');
process.exit(0);
