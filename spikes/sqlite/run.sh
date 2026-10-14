#!/bin/sh
# Runs inside the hk-spike-sqlite container.
set -u
echo "== node $(node -v)"
echo "== plain node: node:sqlite"
node driver-test.cjs node-sqlite 2>&1
echo "== plain node: better-sqlite3"
node driver-test.cjs better-sqlite3 2>&1
echo "== SEA: node:sqlite"
./build-sea.sh driver-test.cjs sea-nodesqlite 2>&1
./out/sea-nodesqlite node-sqlite 2>&1
echo "== SEA: better-sqlite3 (bundled JS, addon loaded from sidecar via nativeBinding)"
./build-sea.sh driver-test.cjs sea-bsqlite 2>&1
NB=node_modules/better-sqlite3/prebuilds/linux-x64.node
echo "addon: $NB ($(du -h "$NB" | cut -f1))"
./out/sea-bsqlite better-sqlite3 "$PWD/$NB" 2>&1
echo "== SEA: better-sqlite3 WITHOUT sidecar (expected to fail)"
./out/sea-bsqlite better-sqlite3 2>&1 | grep -E 'Error|No such' | head -3
echo "== sizes"
ls -lh out/sea-nodesqlite out/sea-bsqlite | awk '{print $5, $9}'
