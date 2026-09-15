// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Prateek
//
// The throwaway wallet the browser tests drive.
//
// This is a Lace profile created by and for this repo's tests, on a local
// devnet or a public testnet. It holds nothing anyone wants: test tokens on
// chains whose whole purpose is to be disposable. It is not, and must never
// become, a wallet with real funds.
//
// The password lived inline in twenty-nine test files. That is a bad shape for
// two reasons and only one of them is about secrets: a credential string
// repeated across a repo reads as a leak whether or not it is one, and changing
// it meant editing twenty-nine files. It lives here now, overridable by
// LACE_PASSWORD so a different machine can use its own.
export const LACE_PASSWORD = process.env.LACE_PASSWORD ?? 'Blank-Statement-Local-1!';

/** Where the extension and its profile are unpacked. Both are build artefacts. */
export const LACE_EXT = process.env.EXT
  ?? `${process.env.HOME}/.cache/blank-statement/extensions/lace-main`;
export const LACE_PROFILE = process.env.PROFILE
  ?? `${process.env.HOME}/.cache/blank-statement/lace-main-profile`;
