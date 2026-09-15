// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Lace's `Undeployed` preset hard-codes the indexer at http://localhost:8088,
// and the field is disabled in its onboarding, so the wallet cannot be pointed
// anywhere else. This stack publishes its indexer on 8188, because 8088 was
// already taken on this machine by an unrelated container.
//
// Rather than renumber the stack or edit another project's compose file, this
// forwards 8088 to wherever the real indexer is. It is a plain TCP relay, so
// the GraphQL POSTs and the WebSocket subscription on the same port both pass
// through untouched: a WebSocket is just an HTTP upgrade over the same socket.
//
// Run it only when port 8088 is free. If something else holds the port this
// exits loudly rather than half-working, because a wallet silently reading the
// wrong chain is the exact failure this exists to prevent.
import net from 'node:net';

const LISTEN = Number(process.env.LACE_PROXY_PORT ?? 8088);
const TARGET = Number(process.env.LACE_INDEXER_PORT ?? 8188);
const HOST = '127.0.0.1';

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET, HOST);
  // Either side going away should take the pair down; half-open sockets here
  // show up later as a wallet that stops syncing for no visible reason.
  const bail = () => { client.destroy(); upstream.destroy(); };
  client.on('error', bail);
  upstream.on('error', bail);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${LISTEN} is already taken. Free it first, for example:`);
    console.error('  docker stop mnapp-indexer');
    process.exit(1);
  }
  console.error('proxy failed:', e.message);
  process.exit(1);
});

server.listen(LISTEN, HOST, () => {
  console.log(`indexer proxy: ${HOST}:${LISTEN} -> ${HOST}:${TARGET}`);
  console.log('Lace can now read the same chain this stack writes to.');
});
