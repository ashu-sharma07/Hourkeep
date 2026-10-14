#!/bin/sh
# usage: build-sea.sh <entry.cjs> <outname> [--external better-sqlite3 handled via nativeBinding]
set -eu
ENTRY=$1; OUT=$2
mkdir -p out
npx esbuild "$ENTRY" --bundle --platform=node --format=cjs --outfile=out/$OUT.bundle.cjs \
  --external:node:sqlite --loader:.node=file --log-level=warning
cat > out/$OUT.sea.json <<JSON
{ "main": "out/$OUT.bundle.cjs", "output": "out/$OUT.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config out/$OUT.sea.json
cp "$(command -v node)" out/$OUT
npx postject out/$OUT NODE_SEA_BLOB out/$OUT.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null 2>&1
chmod +x out/$OUT
