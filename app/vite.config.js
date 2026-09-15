// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;

/**
 * Serve the compiled contract, its prover keys and its zkir at a plain URL.
 *
 * The browser has to fetch these to build a proof for itself: on the server
 * side the SDK reads them off disk with ZkConfig.fromPath, and in a page the
 * same files have to arrive over HTTP. Vite will not serve them on its own
 * because they sit outside the app root, and /@fs/ paths are not a URL the
 * SDK would ever construct.
 */
function serveContractArtifacts() {
  const root = join(repoRoot, 'contracts', 'out');
  const types = {
    '.js': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
    '.wasm': 'application/wasm', '.zkir': 'application/octet-stream',
    '.bzkir': 'application/octet-stream', '.prover': 'application/octet-stream',
    '.verifier': 'application/octet-stream',
  };
  return {
    name: 'contract-artifacts',
    /**
     * A build has no middleware, so the same files have to be copied into the
     * output under the same URL. Without this the page loads, the wallet
     * connects, and proving hangs on a 404 that never surfaces as an error
     * because it is swallowed inside the proving step.
     */
    async generateBundle() {
      const { readdirSync, readFileSync } = await import('node:fs');
      const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory()
          ? walk(join(dir, e.name), `${base}${e.name}/`)
          : [`${base}${e.name}`]));
      for (const rel of walk(root)) {
        this.emitFile({
          type: 'asset',
          fileName: `contracts/out/${rel}`,
          source: readFileSync(join(root, rel)),
        });
      }
      // midday's ZkConfig.fromUrl asks for <circuit>/prover-key rather than
      // keys/<circuit>.prover, so both spellings are emitted. The dev
      // middleware aliases them; a static host cannot.
      for (const f of readdirSync(join(root, 'keys'))) {
        const m = f.match(/^(.+)\.(prover|verifier)$/);
        if (!m) continue;
        this.emitFile({
          type: 'asset',
          fileName: `contracts/out/${m[1]}/${m[2]}-key`,
          source: readFileSync(join(root, 'keys', f)),
        });
      }
      for (const f of readdirSync(join(root, 'zkir'))) {
        const m = f.match(/^(.+)\.bzkir$/);
        if (!m) continue;
        this.emitFile({
          type: 'asset',
          fileName: `contracts/out/${m[1]}/zkir`,
          source: readFileSync(join(root, 'zkir', f)),
        });
      }
    },
    configureServer(server) {
      server.middlewares.use('/contracts/out', (req, res, next) => {
        // normalize collapses any ../ before it can climb out of the directory.
        let rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\.]+)/, '');

        // Two layouts, one set of files. The compiler writes keys/<c>.prover,
        // keys/<c>.verifier and zkir/<c>.bzkir, which is what midnight-js's own
        // FetchZkConfigProvider asks for. midday's ZkConfig.fromUrl asks for
        // <c>/prover-key, <c>/verifier-key and <c>/zkir instead. Serving both
        // spellings costs three lines here; the alternative is a 404 that never
        // surfaces as an error, because it is swallowed inside the proving
        // step and simply hangs.
        const alias = rel.match(/^([A-Za-z0-9_-]+)\/(prover-key|verifier-key|zkir)$/);
        if (alias) {
          const [, circuit, kind] = alias;
          rel = kind === 'zkir' ? `zkir/${circuit}.bzkir`
            : `keys/${circuit}.${kind === 'prover-key' ? 'prover' : 'verifier'}`;
        }

        const file = join(root, rel);
        if (!file.startsWith(root)) { res.statusCode = 403; return res.end('no'); }
        let stat;
        try { stat = statSync(file); } catch { return next(); }
        if (!stat.isFile()) return next();
        const dot = file.lastIndexOf('.');
        res.setHeader('content-type', types[file.slice(dot)] ?? 'application/octet-stream');
        res.setHeader('content-length', stat.size);
        res.setHeader('access-control-allow-origin', '*');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: new URL('.', import.meta.url).pathname,
  // Midnight's ledger and runtime are WebAssembly imported the ESM way, which
  // Vite will not load on its own: "ESM integration proposal for Wasm is not
  // supported". Both plugins are needed together, because those modules use
  // top-level await to instantiate.
  // topLevelAwait only in dev.
  //
  // build.target is esnext, which supports top-level await natively, so the
  // transform has nothing to do there — and running it anyway fails outright
  // ("missing field `type`") the moment the SDK lands in a production chunk,
  // which it does now that the app proves in the browser. Dev still needs it,
  // because esbuild's dependency pre-bundle does not target esnext.
  plugins: [
    wasm(),
    ...(command === 'serve' ? [topLevelAwait()] : []),
    react(),
    serveContractArtifacts(),
  ],
  optimizeDeps: {
    // Only the three packages that actually carry .wasm are held back from the
    // dependency pre-bundle, because esbuild cannot follow a wasm import.
    //
    // The tempting mistake is to exclude the SDK as well. That leaves its whole
    // transitive graph unbundled, and the graph is full of CommonJS:
    // object-inspect, buffer, fetch-retry, thirty polkadot packages,
    // browser-level. Each fails differently ("does not provide an export named
    // X", and finally a bare "exports is not defined"), and naming them one at
    // a time never ends. Pre-bundling handles CommonJS properly, so let it, and
    // keep the exclusion to what genuinely cannot go through it.
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/zkir-v2',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  build: { target: 'esnext' },
  server: {
    host: '127.0.0.1',
    port: 5177,
    // The repo can live on /mnt/c, where inotify never fires, so file changes
    // are invisible to the watcher and the browser silently serves stale CSS.
    watch: { usePolling: true, interval: 300 },
    // The compiled contract, its prover keys and its zkir live outside app/,
    // and the browser has to fetch them to build a proof for itself.
    fs: { allow: [repoRoot] },
    proxy: {
      '/idx': { target: 'http://127.0.0.1:8188', changeOrigin: true, rewrite: p => p.replace(/^\/idx/, '') },
    },
  },
}));
