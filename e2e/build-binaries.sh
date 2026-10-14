#!/bin/sh
# Bundle the built daemon and CLI into Node single-executable binaries.
# Runs inside the build stage of e2e/Dockerfile, after `pnpm build`.
# usage: build-binaries.sh <repo-root> <tools-dir> <out-dir>
set -eu
SRC=$1; TOOLS=$2; OUT=$3
mkdir -p "$OUT"
ESBUILD="$TOOLS/node_modules/.bin/esbuild"
POSTJECT="$TOOLS/node_modules/.bin/postject"

# Strip once; both binaries start from the same stripped node.
strip -o "$OUT/node.stripped" "$(command -v node)"

make_sea() { # name entry
  name=$1; entry=$2
  # node:sqlite is a built-in that esbuild's platform list may not know yet.
  "$ESBUILD" "$entry" --bundle --platform=node --format=cjs --target=node22 \
    --external:node:sqlite --log-level=warning --outfile="$OUT/$name.cjs"
  # A SEA main script is not a file on disk, so drop the shebang line.
  sed -i '1{/^#!/d}' "$OUT/$name.cjs"
  cat > "$OUT/$name.sea.json" <<JSON
{
  "main": "$OUT/$name.cjs",
  "output": "$OUT/$name.blob",
  "disableExperimentalSEAWarning": true,
  "execArgv": ["--disable-warning=ExperimentalWarning"]
}
JSON
  node --experimental-sea-config "$OUT/$name.sea.json"
  cp "$OUT/node.stripped" "$OUT/$name"
  "$POSTJECT" "$OUT/$name" NODE_SEA_BLOB "$OUT/$name.blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null 2>&1
  chmod 755 "$OUT/$name"
}

make_sea hourkeepd "$SRC/apps/daemon/dist/main.js"
make_sea hourkeep "$SRC/apps/cli/dist/main.js"

# SO_PEERCRED addon, built against the same Node headers.
"$SRC/apps/daemon/native/build.sh" "$OUT/peercred.node"
ls -lh "$OUT/hourkeepd" "$OUT/hourkeep" "$OUT/peercred.node"
