#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Prateek
# Compile the Compact contract to contracts/out.
#
# Pins toolchain 0.31.1 deliberately: every live Midnight network runs ledger 8,
# and 0.33.x targets ledger 9, which is not deployed anywhere yet. 0.31.0 has a
# documented soundness bug, so 0.31.1 is the floor as well as the ceiling.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$HERE/contracts/src/statement.compact"
OUT="$HERE/contracts/out"

# Never resolve `compact` from PATH on Windows: C:\WINDOWS\system32\compact.exe
# is the NTFS compression tool and will silently win.
COMPACT="${COMPACT:-$HOME/.local/bin/compact}"
[ -x "$COMPACT" ] || { echo "compact devtools not found at $COMPACT"; exit 1; }

echo "toolchain: $("$COMPACT" --version)"
rm -rf "$OUT"
time "$COMPACT" compile "$SRC" "$OUT"

echo
echo "circuits:            $(find "$OUT/keys" -name '*.verifier' | wc -l)"
echo "verifier keys total: $(find "$OUT/keys" -name '*.verifier' -printf '%s\n' | paste -sd+ | bc) bytes"
echo "prover keys total:   $(find "$OUT/keys" -name '*.prover'   -printf '%s\n' | paste -sd+ | bc) bytes"
echo
echo "Verifier keys are what the deploy transaction carries and they are small."
echo "Prover keys are what a client must fetch before it can prove anything, and"
echo "they are roughly 2.8 MB per circuit. That is the number that shapes the app."
