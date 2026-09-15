// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Serve the built app the way a static host does, and nothing else.
//
// The point is what is NOT here: no bridge, no API, no wallet, no proving.
// If the product works against this, it works on any static host, because
// this is less than any static host provides.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(process.env.DIST ?? 'app/dist');
const PORT = Number(process.env.PORT ?? 5178);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let file = join(ROOT, path);
  // Everything outside the build is off limits, however the path is spelled.
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end('no'); }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    // A single-page app owns its routes, so an unknown path is the app, not a
    // 404 — except for the artefacts, where a wrong 200 would be worse than a
    // clean miss: proving swallows the error and hangs instead of failing.
    if (path.startsWith('/contracts/')) { res.statusCode = 404; return res.end('no such artefact'); }
    file = join(ROOT, 'index.html');
  }
  try {
    const body = readFileSync(file);
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-length', body.length);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`the build, statically, on http://127.0.0.1:${PORT}`);
  console.log('no bridge, no API, no server-side anything');
});
