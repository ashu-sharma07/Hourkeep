#!/bin/bash
# Browser bypass check: real Chromium and Firefox against a hosts block set by the real daemon.
# Runs entirely inside Docker. Needs network access to reach YouTube for the baseline.
# usage: e2e/browsers/run.sh
set -u
cd "$(dirname "$0")/../.."
C=hk-browsers-test
x()  { docker exec "$C" "$@"; }
xu() { docker exec -u member "$C" "$@"; }
docker rm -f $C >/dev/null 2>&1
echo "building images (first run downloads browsers, a few minutes)..."
docker build -q -f e2e/Dockerfile -t hk-e2e . >/dev/null || exit 1
docker build -q -f e2e/browsers/Dockerfile -t hk-browsers . >/dev/null || exit 1
trap 'docker rm -f $C >/dev/null 2>&1' EXIT
docker run -d --name $C --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --shm-size=1g \
  --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --cap-add SYS_ADMIN --security-opt apparmor=unconfined hk-browsers >/dev/null || exit 1
for _ in $(seq 60); do st=$(x systemctl is-system-running 2>/dev/null); case "$st" in running|degraded) break;; esac; sleep 0.5; done
for _ in $(seq 40); do x systemctl is-active hourkeepd >/dev/null 2>&1 && break; sleep 0.5; done
x systemctl is-active hourkeepd >/dev/null || { echo "hourkeepd not running"; exit 1; }
x sh -c '. /etc/os-release; echo "$PRETTY_NAME"'

rc=0
echo; echo "=== baseline: nothing blocked, browsers must reach YouTube"
xu sh -c 'cd /opt/browsers && node check.mjs baseline' || rc=1

echo; echo "=== hourkeep block youtube"
xu hourkeep block youtube | head -1
echo; echo "=== blocked: YouTube must be unreachable in every window; control site still reachable"
xu sh -c 'cd /opt/browsers && node check.mjs blocked' || rc=1

echo; echo "=== known limitation probe: Firefox with DNS-over-HTTPS forced (informational, not asserted)"
xu sh -c 'cd /opt/browsers && node check.mjs doh'

echo; echo "=== after unblock: browsers must reach YouTube again"
xu hourkeep unblock youtube | head -1
xu sh -c 'cd /opt/browsers && node check.mjs baseline' || rc=1
echo; [ $rc -eq 0 ] && echo "BROWSER CHECK: OK" || echo "BROWSER CHECK: FAILED"
exit $rc
