#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Prateek
# Bring the local Midnight ledger-8 stack up or down.
#
# Must run inside WSL on Windows. The Compact toolchain and the Midnight images do
# not run under native Windows, and `compact` on the Windows PATH is the NTFS
# file-compression tool, not the compiler.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/standalone.yml"
INDEXER_PORT="${INDEXER_PORT:-8188}"
NAMES="midnight-node midnight-indexer midnight-proof-server"

running() { docker ps -q --filter "name=^$1$" | grep -q . ; }
all_running() { for n in $NAMES; do running "$n" || return 1; done; }
healthy() {
  curl -sf -m 3 http://127.0.0.1:6300/health >/dev/null 2>&1 &&
  curl -s -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' \
       -d '{"query":"{ __typename }"}' "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql"
}
report() {
  docker ps --filter "name=midnight-" --format '{{.Names}}\t{{.State}}\t{{.Ports}}'
  echo
  echo "node        ws://127.0.0.1:9944"
  echo "indexer     http://127.0.0.1:$INDEXER_PORT/api/v4/graphql"
  echo "proof srv   http://127.0.0.1:6300"
}

up() {
  command -v docker >/dev/null || { echo "docker not found"; exit 1; }
  docker info >/dev/null 2>&1 || { echo "docker daemon is not running"; exit 1; }

  if all_running && healthy; then
    echo "stack already running"; echo; report; return 0
  fi

  # Containers may exist from a previous run, possibly under a different compose
  # project. Clear them by name so compose can own them cleanly.
  for n in $NAMES; do docker rm -f "$n" >/dev/null 2>&1 || true; done

  # 8088 is the image default and is often taken by another project's indexer,
  # so bind elsewhere and tell the app about it.
  if ss -ltn 2>/dev/null | grep -q ":$INDEXER_PORT "; then
    echo "port $INDEXER_PORT is held by something else; set INDEXER_PORT=<free port> and re-run"
    exit 1
  fi
  sed -i "s|'127.0.0.1:[0-9]*:8088'|'127.0.0.1:$INDEXER_PORT:8088'|" "$COMPOSE"

  docker compose -f "$COMPOSE" up -d
  echo "waiting for services..."
  for _ in $(seq 1 60); do healthy && break; sleep 3; done
  healthy || { echo "services did not become healthy"; docker compose -f "$COMPOSE" ps; exit 1; }
  echo; report
}

down() {
  docker compose -f "$COMPOSE" down --remove-orphans 2>/dev/null || true
  for n in $NAMES; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  echo "stack down"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: stack.sh [up|down]"; exit 1 ;;
esac
