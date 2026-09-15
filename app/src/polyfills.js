// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// Node globals that the Midnight stack reaches for in the browser.
//
// midday-sdk and the polkadot packages underneath it were written for Node and
// use `Buffer` and `global` freely. Vite externalises `buffer` rather than
// polyfilling it, so without this the first call that touches a Buffer fails at
// runtime with "Module buffer has been externalized" — long after the import
// succeeded, which makes it look like a logic bug rather than a missing global.
//
// Imported for its side effects, first, before anything that might use them.
import { Buffer } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
if (typeof globalThis.process === 'undefined') globalThis.process = { env: {}, browser: true, version: '' };

// `fetch` must be called with the window as its receiver. Library code written
// for Node passes it around as a plain value — `const f = globalThis.fetch` —
// and in a browser that throws "Failed to execute 'fetch' on 'Window': Illegal
// invocation" the moment it is used. It surfaces far from the cause: here it
// arrived as "Failed to join contract", from the provider that reads chain
// state. Replacing it with an already-bound copy makes every such reference
// work, and changes nothing for callers that do it properly.
if (typeof globalThis.fetch === 'function' && !globalThis.fetch.__bound) {
  const bound = globalThis.fetch.bind(globalThis);
  bound.__bound = true;
  globalThis.fetch = bound;
}
