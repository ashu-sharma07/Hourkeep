#!/bin/sh
# Build the SO_PEERCRED N-API addon. Needs gcc and the Node headers (set NODE_INCLUDE
# if they are not in the default place). Usage: native/build.sh <output.node>
set -eu
OUT=${1:?usage: build.sh <output.node>}
INC=${NODE_INCLUDE:-$(dirname "$(dirname "$(command -v node)")")/include/node}
gcc -shared -fPIC -O2 -Wall -Wextra -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -DNAPI_VERSION=8 -I"$INC" "$(dirname "$0")/peercred.c" -o "$OUT"
