/**
 * Standalone Fee Relay Server for Docker.
 *
 * Balances and submits transactions using the genesis wallet on behalf
 * of browser wallets that have no dust/tDUST.
 *
 * Environment variables:
 *   NETWORK_ID - Network ID (default: undeployed)
 *   INDEXER_URL - Indexer HTTP URL
 *   INDEXER_WS_URL - Indexer WebSocket URL
 *   NODE_URL - Node WebSocket URL
 *   PROOF_SERVER_URL - Proof server URL
 *   FEE_RELAY_PORT - Port to listen on (default: 3002)
 */
import { createServer } from 'http';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { Transaction, type FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { WalletEntrySchema, mergeWalletEntries } from '@midnight-ntwrk/wallet-sdk-facade';

// Configuration from environment
const config = {
  networkId: process.env.NETWORK_ID || 'undeployed',
  indexer: process.env.INDEXER_URL || 'http://indexer:8088/api/v3/graphql',
  indexerWS: process.env.INDEXER_WS_URL || 'ws://indexer:8088/api/v3/graphql/ws',
  node: process.env.NODE_URL || 'ws://node:9944',
  proofServer: process.env.PROOF_SERVER_URL || 'http://proof-server:6300',
  port: parseInt(process.env.FEE_RELAY_PORT || '3002', 10),
};

/**
 * The wallet this relay pays fees from.
 *
 * It must be the relay's own. Sharing one with an application holder means both
 * build transactions against the same DUST inputs, and whichever submits second
 * is spending inputs that are already gone — the node answers
 * `1010: Invalid Transaction: Custom error: 196` and the failure lands on the
 * *user's* transaction, not the relay's. It also makes the sponsorship bill
 * indistinguishable from the app's own balance.
 *
 * Defaults to the devnet genesis seed because that is the only pre-funded
 * wallet on a local chain and a relay with no money is useless. Any other
 * network must supply FEE_RELAY_SEED.
 */
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/** Seeds the application itself spends from. The relay may not use these. */
const APP_HOLDER_SEEDS = new Set([
  '0'.repeat(63) + '1',
  '0'.repeat(63) + '2',
  '0'.repeat(63) + '3',
]);

const RELAY_SEED = (() => {
  const given = process.env.FEE_RELAY_SEED?.trim();
  if (given) {
    if (!/^[0-9a-fA-F]{64}$/.test(given)) {
      throw new Error('FEE_RELAY_SEED must be 64 hex characters');
    }
    const lower = given.toLowerCase();
    // Refuse rather than collide. A silent overlap is worse than not booting:
    // it works in every one-write-at-a-time test and fails under real load.
    if (APP_HOLDER_SEEDS.has(lower)) {
      throw new Error(
        'FEE_RELAY_SEED is one of the application holder wallets. The relay needs its own funded wallet, ' +
        'or its transactions will collide with those of the app under load. See FINDING-03.',
      );
    }
    return lower;
  }
  if (config.networkId === 'undeployed') {
    // Three calls rather than one joined string: the fallback is the case a
    // reader most needs to notice, and a single long line gets skimmed.
    console.warn('[FeeRelay] No FEE_RELAY_SEED set; falling back to the devnet genesis wallet.');
    console.warn('[FeeRelay] The app spends from that wallet too, so concurrent writes can collide.');
    console.warn('[FeeRelay] Set FEE_RELAY_SEED to a funded wallet of its own. See FINDING-03.');
    return GENESIS_SEED;
  }
  throw new Error(
    `FEE_RELAY_SEED is required on ${config.networkId}. There is no pre-funded wallet outside the local devnet.`,
  );
})();

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface DerivedKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
}

function deriveKeys(seed: string, networkId: string): DerivedKeys {
  const seedBytes = hexToBytes(seed);
  const hdWallet = HDWallet.fromSeed(seedBytes);
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }
  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    derivationResult.keys[Roles.NightExternal],
    networkId as 'undeployed',
  );

  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

async function createWallet(keys: DerivedKeys): Promise<WalletFacade> {
  const walletConfig = {
    networkId: config.networkId as 'undeployed',
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    relayURL: new URL(config.node),
    provingServerUrl: new URL(config.proofServer),
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    indexerUrl: config.indexerWS,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: () => ShieldedWallet(walletConfig).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: () =>
      UnshieldedWallet(walletConfig).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: () =>
      DustWallet(walletConfig).startWithSecretKey(
        keys.dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await wallet.start(keys.shieldedSecretKeys, keys.dustSecretKey);

  // Wait for sync
  await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));

  return wallet;
}

// The relay's wallet — initialized lazily on first request, then kept alive
let walletPromise: Promise<{ wallet: WalletFacade; keys: DerivedKeys }> | null = null;

function getWallet(): Promise<{ wallet: WalletFacade; keys: DerivedKeys }> {
  if (!walletPromise) {
    walletPromise = (async () => {
      console.log('[FeeRelay] Initializing the relay wallet...');
      const keys = deriveKeys(RELAY_SEED, config.networkId);
      const wallet = await createWallet(keys);
      console.log('[FeeRelay] Relay wallet ready');
      return { wallet, keys };
    })();
  }
  return walletPromise;
}

// HTTP Server
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/balance-tx') {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', async () => {
      try {
        const { tx: txHex } = JSON.parse(body);
        if (!txHex) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing tx field (hex-encoded UnboundTransaction)' }));
          return;
        }

        const { wallet, keys } = await getWallet();

        // Deserialize UnboundTransaction from hex
        // UnboundTransaction = Transaction<SignatureEnabled, Proof, PreBinding>
        const txBytes = hexToBytes(txHex);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unboundTx = Transaction.deserialize(
          'signature' as ledger.SignatureEnabled['instance'],
          'proof' as ledger.Proof['instance'],
          'pre-binding' as ledger.PreBinding['instance'],
          txBytes,
        ) as any;

        // Balance and finalize using genesis wallet
        const ttl = new Date(Date.now() + 30 * 60 * 1000);
        const recipe = await wallet.balanceUnboundTransaction(
          unboundTx,
          {
            shieldedSecretKeys: keys.shieldedSecretKeys,
            dustSecretKey: keys.dustSecretKey,
          },
          { ttl },
        );
        const finalized = await wallet.finalizeRecipe(recipe);

        // Serialize back to hex
        const finalizedBytes = finalized.serialize();
        const finalizedHex = bytesToHex(finalizedBytes);

        console.log(`[FeeRelay] Balanced transaction`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tx: finalizedHex }));
      } catch (error) {
        console.error('[FeeRelay] balance-tx error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
    });
    return;
  }

  // Added for the midday-sdk relay client, which posts an already user-balanced
  // FinalizedTransaction here and expects the relay to add only the dust.
  if (req.method === 'POST' && req.url === '/balance-finalized-tx') {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', async () => {
      try {
        const { tx: txHex } = JSON.parse(body);
        if (!txHex) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing tx field' }));
          return;
        }
        const { wallet, keys } = await getWallet();
        const finalizedTx = Transaction.deserialize(
          'signature' as ledger.SignatureEnabled['instance'],
          'proof' as ledger.Proof['instance'],
          'binding' as ledger.Binding['instance'],
          hexToBytes(txHex),
        ) as unknown as FinalizedTransaction;

        const ttl = new Date(Date.now() + 30 * 60 * 1000);
        const recipe = await wallet.balanceFinalizedTransaction(
          finalizedTx,
          { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
          { ttl },
        );
        const finalized = await wallet.finalizeRecipe(recipe);
        console.log('[FeeRelay] Added dust to a finalized transaction');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tx: bytesToHex(finalized.serialize()) }));
      } catch (error) {
        console.error('[FeeRelay] balance-finalized-tx error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/submit-tx') {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', async () => {
      try {
        const { tx: txHex } = JSON.parse(body);
        if (!txHex) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing tx field (hex-encoded FinalizedTransaction)' }));
          return;
        }

        const { wallet } = await getWallet();

        // Deserialize FinalizedTransaction from hex
        // FinalizedTransaction = Transaction<SignatureEnabled, Proof, Binding>
        const txBytes = hexToBytes(txHex);
        const finalizedTx = Transaction.deserialize(
          'signature' as ledger.SignatureEnabled['instance'],
          'proof' as ledger.Proof['instance'],
          'binding' as ledger.Binding['instance'],
          txBytes,
        ) as unknown as FinalizedTransaction;

        // Submit via genesis wallet
        const txId = await wallet.submitTransaction(finalizedTx);

        console.log(`[FeeRelay] Submitted TX: ${txId.slice(0, 16)}...`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ txId }));
      } catch (error) {
        console.error('[FeeRelay] submit-tx error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[FeeRelay] Server running on port ${config.port}`);
  console.log(`[FeeRelay] Network: ${config.networkId}`);
  console.log(`[FeeRelay] POST /balance-tx - Balance an unbound transaction`);
  console.log(`[FeeRelay] POST /balance-finalized-tx - Add dust to a finalized transaction`);
  console.log(`[FeeRelay] POST /submit-tx - Submit a finalized transaction`);
  console.log(`[FeeRelay] GET /health - Health check`);
});
