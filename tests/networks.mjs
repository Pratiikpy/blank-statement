// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// All three Midnight networks, through the real wallet.
//
// Everything else in this repo runs on `undeployed`, the local chain. Midnight
// has two more — `preview` and `preprod` — and a product that only ever works
// on the developer's own chain is not a product. Lace offers all three in
// Settings > Network, so this switches between them the way a person does and
// checks what the app and the connector report on each.
//
// What it does NOT do is write on the public networks. That needs DUST, DUST
// needs NIGHT registered at mint time, and the faucet is behind a captcha this
// is not allowed to answer. So the writes stay local and the public networks
// are tested for everything that does not cost a fee: the wallet switches, the
// addresses change with the network, the endpoints change with them, and the
// public chains are reachable and answering.
//
// That distinction is the point. Saying "tested on three networks" when two of
// them were only ever read from would be the kind of claim this project exists
// to avoid.
//
//   node tests/networks.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LACE_PASSWORD } from './lace-fixture.mjs';

const EXT = process.env.EXT ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
const PROFILE = process.env.PROFILE ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
const APP = process.env.APP ?? 'http://127.0.0.1:5177';
const OUT = process.env.OUT ?? '/mnt/c/Users/prate/downloads/mid/qa-evidence/2026-08-24/networks';
const PASSWORD = LACE_PASSWORD;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
const check = (id, label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? '  — ' + detail : ''}`);
  results.push({ id, label, ok, detail });
  if (!ok) failures++;
};
const note = (m) => console.log(`  ....  ${m}`);

// ---------------------------------------------------------------------------
console.log('1. are the public networks actually up?');
// ---------------------------------------------------------------------------
const publicHeight = async (net) => {
  try {
    const r = await fetch(`https://indexer.${net}.midnight.network/api/v4/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{block{height}}' }),
      signal: AbortSignal.timeout(15000),
    });
    return Number((await r.json())?.data?.block?.height ?? 0);
  } catch (e) { return 'unreachable: ' + String(e.message).slice(0, 50); }
};
const heights = {};
for (const net of ['preview', 'preprod']) {
  heights[net] = await publicHeight(net);
  check(`N-${net}-up`, `${net} is reachable and producing blocks`,
    typeof heights[net] === 'number' && heights[net] > 0, String(heights[net]));
}

// ---------------------------------------------------------------------------
console.log('\n2. switching the wallet between all three, as a person does');
// ---------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
let sw = null;
for (let i = 0; i < 15 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await sleep(1000); }
if (!sw) { console.log('the extension never started'); await ctx.close(); process.exit(2); }
const extId = new URL(sw.url()).host;

const ui = await ctx.newPage();
await ui.setViewportSize({ width: 1280, height: 1100 });
const openWallet = async () => {
  await ui.goto(`chrome-extension://${extId}/expo/index.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(12000);
  const pw = ui.locator('input[type="password"]:visible').first();
  if (await pw.count().catch(() => 0)) {
    await pw.click().catch(() => {});
    await pw.type(PASSWORD, { delay: 30 }).catch(() => {});
    await sleep(1500);
    const ok = ui.locator('[data-testid*="confirm"], button:has-text("Confirm")').first();
    if (await ok.count().catch(() => 0)) await ok.click().catch(() => {});
    else await ui.keyboard.press('Enter').catch(() => {});
    await sleep(10000);
  }
};
const tap = async (id) => {
  const el = ui.locator(`[data-testid="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;
  await el.click({ timeout: 15000 }).catch(() => {});
  await sleep(3500);
  return true;
};
const switchTo = async (net) => {
  // Re-open and unlock every time. The extension locks itself on a timeout, and
  // once it does the settings tab is not on the page at all, so the switch
  // silently does nothing and the connector then refuses with "Network ID
  // mismatch" — which reads like a product fault and is the wallet correctly
  // refusing to connect on a network it is not set to.
  await openWallet();
  await tap('settings-tab-btn');
  await tap('option-list-item-network');
  const picked = await tap(`radio-button-midnight-${net}`);
  await tap('network-selection-sheet-confirm-button');
  await sleep(15000);
  return picked;
};

await openWallet();

// The page reads the connector, which is the honest source for what the wallet
// thinks it is on.
const page = await ctx.newPage();
const readConnector = async (net) => page.evaluate(async (n) => {
  const key = Object.keys(window.midnight ?? {})[0];
  if (!key) return { error: 'no connector' };
  try {
    const s = await window.midnight[key].connect(n);
    const cfg = await s.getConfiguration();
    const { unshieldedAddress } = await s.getUnshieldedAddress();
    let night = 0n;
    try {
      const b = await s.getUnshieldedBalances();
      night = Object.values(b ?? {}).reduce((a, x) => a + BigInt(x ?? 0n), 0n);
    } catch { /* some networks answer nothing until synced */ }
    let dust = '0';
    try { dust = String((await s.getDustBalance())?.balance ?? 0n); } catch { /* same */ }
    return {
      networkId: cfg.networkId,
      indexer: cfg.indexerUri,
      prover: cfg.proverServerUri,
      address: unshieldedAddress,
      night: night.toString(),
      dust,
    };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 120) }; }
}, net).catch((e) => ({ error: String(e.message).slice(0, 80) }));

const seen = {};
for (const net of ['preview', 'preprod', 'undeployed']) {
  console.log(`\n  --- ${net} ---`);
  const picked = await switchTo(net);
  check(`S-${net}-radio`, `Lace offers ${net} and takes it`, picked);

  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(6000);
  const c = await readConnector(net);
  seen[net] = c;
  if (c.error) {
    check(`S-${net}-connect`, `the connector answers on ${net}`, false, c.error);
    continue;
  }
  console.log(`     address : ${String(c.address).slice(0, 42)}…`);
  console.log(`     indexer : ${c.indexer}`);
  console.log(`     prover  : ${c.prover}`);
  console.log(`     tNIGHT  : ${c.night}   DUST: ${c.dust}`);

  check(`S-${net}-id`, `the connector reports ${net}`, c.networkId === net, c.networkId);
  check(`S-${net}-addr`, `the address carries the ${net} prefix`,
    String(c.address).startsWith(`mn_addr_${net}`), String(c.address).slice(0, 30));
  // The endpoints must follow the network, or the wallet is reading one chain
  // and signing for another.
  if (net === 'undeployed') {
    check(`S-${net}-endpoints`, 'it points at the local stack',
      /localhost|127\.0\.0\.1/.test(c.indexer) && /localhost|127\.0\.0\.1/.test(c.prover),
      `${c.indexer} | ${c.prover}`);
  } else {
    check(`S-${net}-endpoints`, `it points at the ${net} services`,
      c.indexer.includes(net) && c.prover.includes(net), `${c.indexer} | ${c.prover}`);
  }
  await ui.screenshot({ path: `${OUT}/wallet-${net}.png`, fullPage: true }).catch(() => {});
  await page.screenshot({ path: `${OUT}/app-${net}.png`, fullPage: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
console.log('\n3. the same key, three networks, three addresses');
// ---------------------------------------------------------------------------
{
  const addrs = Object.entries(seen)
    .filter(([, v]) => v && !v.error)
    .map(([n, v]) => [n, v.address]);
  // Guard the count: with every network erroring, addrs is empty and a naive
  // set-size comparison passes for having found nothing.
  check('X1', 'every network gave a distinct address',
    addrs.length === 3 && new Set(addrs.map(([, a]) => a)).size === 3,
    addrs.length ? addrs.map(([n, a]) => `${n}:${String(a).slice(-8)}`).join(' ') : 'no addresses read');
  // The tail differs because the prefix is part of what is encoded, but the
  // same wallet is behind all three; the payload should match.
  const payloads = addrs.map(([n, a]) => [n, String(a).replace(/^mn_addr_[a-z]+1/, '').slice(0, 30)]);
  check('X2', 'and they are the same wallet underneath',
    payloads.length === 3 && new Set(payloads.map(([, p]) => p)).size === 1,
    payloads.map(([n, p]) => `${n}:${p.slice(0, 12)}`).join(' '));
}

// ---------------------------------------------------------------------------
console.log('\n4. what can and cannot be done on each');
// ---------------------------------------------------------------------------
{
  for (const [net, c] of Object.entries(seen)) {
    if (!c || c.error) continue;
    const canPay = BigInt(c.dust || '0') > 0n;
    console.log(`  ${net.padEnd(11)} tNIGHT ${String(c.night).padEnd(12)} DUST ${String(c.dust).padEnd(12)} ${canPay ? 'can write' : 'READ ONLY'}`);
  }
  const pv = seen.preview;
  if (pv && !pv.error) {
    check('W1', 'preview holds NIGHT from the earlier faucet drop',
      BigInt(pv.night || '0') > 0n, pv.night);
    // This is the honest statement of the limit, asserted rather than assumed.
    check('W2', 'and still cannot pay a fee, which is why writes stay local',
      BigInt(pv.dust || '0') === 0n, pv.dust);
    note('the NIGHT there arrived by transfer, so it is unregistered and makes no DUST');
    note('registering needs a fee it does not have; a faucet mint would arrive registered');
    note('the faucet is behind a captcha, which this is not permitted to answer');
  }
}

// Leave the wallet where the rest of the suite expects it.
console.log('\nputting the wallet back on undeployed');
await switchTo('undeployed');
const back = await readConnector('undeployed');
check('Z1', 'the wallet is back on the local network',
  back?.networkId === 'undeployed', back?.networkId ?? back?.error ?? '');

console.log('\n=== summary ===');
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (failures) {
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}  ${r.label}  — ${r.detail}`);
}
await ctx.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
