#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Prateek
#
# Bring the local development stack back up after a reboot.
#
# The containers restart themselves, but the dev server and the bridge do not,
# and the bridge takes minutes to seed because it deploys the contract and
# anchors every holder's record on a fresh chain.
#
#   bash scripts/dev-up.sh
set -u
cd "$(dirname "$0")/.." || exit 1

# Match the vite command specifically, and with a bracket, so the grep never
# matches itself and takes the calling shell down with it.
stop() {
  for P in $(ps -eo pid,cmd | grep "$1" | awk '{print $1}'); do
    kill "$P" 2>/dev/null
  done
}

echo "stopping anything already running"
stop '[v]ite --config app/vite.config.js'
stop '[b]ridge.mjs'
sleep 4

echo "waiting for the chain"
for i in $(seq 1 60); do
  if curl -s -o /dev/null -m 5 http://127.0.0.1:6300/health; then break; fi
  sleep 2
done
printf '  proof server: '
curl -s -o /dev/null -m 8 -w '%{http_code}\n' http://127.0.0.1:6300/health

echo "starting the dev server"
setsid npx vite --config app/vite.config.js --host 127.0.0.1 --port 5177 --strictPort \
  > /tmp/vite.log 2>&1 &
sleep 25
printf '  app: '
curl -s -o /dev/null -m 10 -w '%{http_code}\n' http://127.0.0.1:5177/

echo "starting the bridge (it deploys and seeds, so give it a few minutes)"
setsid node app/bridge.mjs > /tmp/bridge.log 2>&1 &
echo "  logging to /tmp/bridge.log"

echo
echo "Lace's indexer proxy is separate: bash scripts/lace-indexer-proxy.mjs"
echo "and it needs port 8088 free (docker stop mnapp-indexer)."
