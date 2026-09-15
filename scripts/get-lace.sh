#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Prateek
#
# Fetch and unpack the Lace extensions used by the wallet tests.
#
# They live under ~/.cache, not /tmp, because a WSL restart empties /tmp and
# takes the unpacked extensions with it. The wallet profiles beside them
# survive, so the failure looks like a broken extension rather than a missing
# one: Chrome answers ERR_BLOCKED_BY_CLIENT for every chrome-extension:// page
# and says nothing about why.
#
#   bash scripts/get-lace.sh          # both
#   bash scripts/get-lace.sh main     # just the main extension
set -u

DEST="${LACE_DIR:-$HOME/.cache/blank-statement/extensions}"
mkdir -p "$DEST"

# Lace Midnight Preview: the only build that offers the local `undeployed`
# network, and deprecated — it signs and never answers the page.
PREVIEW=hgeekaiplokcnmakghbdfbgnlfheichg
# Lace (main): has real Midnight accounts and answers properly, but its network
# picker offers Mainnet and Testnet only.
MAIN=gafhhkghbfjjkeiendhlofajokpaflmk

fetch() {
  # Separate statements on purpose: within a single `local`, $name is not yet
  # assigned when out= is evaluated, and `set -u` turns that into a hard stop.
  local id="$1"
  local name="$2"
  local out="$DEST/$name"
  if [ -f "$out/manifest.json" ]; then
    echo "$name: already unpacked at $out"
    return 0
  fi
  local url="https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120&acceptformat=crx2,crx3&x=id%3D${id}%26uc"
  local crx="$DEST/$name.crx"
  local size
  size=$(curl -sL -m 600 -o "$crx" -w '%{size_download}' "$url" 2>/dev/null)
  echo "$name: downloaded ${size} bytes"
  [ "${size:-0}" -lt 100000 ] && { echo "$name: too small to be a crx"; return 1; }

  python3 - "$crx" "$out" <<'PY'
import sys, zipfile, io, os, json
src, out = sys.argv[1], sys.argv[2]
d = open(src, 'rb').read()
i = d.find(b'PK\x03\x04')
if d[:4] != b'Cr24' or i <= 0:
    print('  not a crx3'); raise SystemExit(1)
os.makedirs(out, exist_ok=True)
zipfile.ZipFile(io.BytesIO(d[i:])).extractall(out)
m = json.load(open(os.path.join(out, 'manifest.json')))
print('  ->', m.get('name'), m.get('version'))
PY
}

case "${1:-both}" in
  preview) fetch "$PREVIEW" lace-preview ;;
  main)    fetch "$MAIN" lace-main ;;
  *)       fetch "$MAIN" lace-main; fetch "$PREVIEW" lace-preview ;;
esac

echo
echo "extensions in $DEST:"
ls -d "$DEST"/*/ 2>/dev/null
echo
echo "use with:  EXT=$DEST/lace-main   (or lace-preview)"
