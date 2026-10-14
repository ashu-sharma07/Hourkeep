#!/bin/bash
# End-to-end test: real systemd, real single-executable binaries, real /etc/hosts inside Docker.
# Never touches the host: everything below runs in a throwaway container.
# usage: e2e/run.sh            (from anywhere; builds the image first)
set -u
cd "$(dirname "$0")/.."
C=hk-e2e-test
IMG=hk-e2e
INTERVAL=5          # default reconcile interval of hourkeepd, in seconds
x()  { docker exec "$C" "$@"; }
xu() { local u=$1; shift; docker exec "$C" su "$u" -c "$*"; }
pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
chk() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
hosts() { x cat /etc/hosts; }
wait_active() { for _ in $(seq 40); do x systemctl is-active hourkeepd >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
# wait until the command succeeds, up to $1 seconds; prints elapsed seconds
wait_until() { local t=$1; shift; local s=$SECONDS; while [ $((SECONDS - s)) -le "$t" ]; do eval "$*" && { echo $((SECONDS - s)); return 0; }; sleep 0.25; done; echo $((SECONDS - s)); return 1; }

docker rm -f $C >/dev/null 2>&1
docker build -q -f e2e/Dockerfile -t $IMG . >/dev/null || { echo "image build failed"; exit 1; }
trap 'docker rm -f $C >/dev/null 2>&1' EXIT
docker run -d --name $C --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --cap-add SYS_ADMIN --security-opt apparmor=unconfined $IMG >/dev/null || exit 1
for _ in $(seq 60); do
  st=$(x systemctl is-system-running 2>/dev/null); case "$st" in running|degraded) break;; esac; sleep 0.5
done
[ "$(docker inspect -f '{{.State.Running}}' $C)" = true ] || { echo "container not running"; exit 1; }
wait_active || { echo "hourkeepd did not start"; x journalctl -u hourkeepd --no-pager | tail -20; exit 1; }

echo "=== environment"
x sh -c '. /etc/os-release; echo $PRETTY_NAME; command -v node >/dev/null && echo "node: PRESENT (unexpected)" || echo "node: not installed"; ls -lh /usr/bin/hourkeepd /usr/bin/hourkeep | awk "{print \$5, \$9}"'
ORIG=$(hosts)

echo "=== 1. service and access control"
chk "hourkeepd is active (Type=notify reached READY)" 'x systemctl is-active hourkeepd | grep -qx active'
chk "no node on PATH: binaries are self-contained" '[ "$(x sh -c "command -v node || echo none")" = none ]'
chk "socket is 0660 root:hourkeep" '[ "$(x stat -c "%a %U:%G" /run/hourkeep/hourkeep.sock)" = "660 root:hourkeep" ]'
chk "state dir is 0700 and db is 0600" '[ "$(x stat -c "%a" /var/lib/hourkeep)" = 700 ] && [ "$(x stat -c %a /var/lib/hourkeep/hourkeep.db)" = 600 ]'
chk "group member can run 'hourkeep status'" 'xu member "hourkeep status" | grep -q "Rules:"'
chk "daemon sees the caller's real uid via SO_PEERCRED" '[ "$(xu member "hourkeep status")" != "" ] && xu member "hourkeep status" | grep -q "uid $(x id -u member)"'
chk "outsider is denied with a helpful message" 'xu outsider "hourkeep status" 2>&1 | grep -q "permission denied"'
chk "outsider exit code is 1" '! xu outsider "hourkeep status" >/dev/null 2>&1'
x journalctl -u hourkeepd --no-pager -o cat | tail -3

echo "=== 2. block youtube"
chk "member: hourkeep block youtube succeeds" 'xu member "hourkeep block youtube" | grep -q "Blocked youtube (group)"'
chk "hosts file has the managed block" 'hosts | grep -q "BEGIN HOURKEEP MANAGED BLOCK"'
chk "name resolution (nsswitch/files) returns 0.0.0.0 for youtube.com" 'x getent ahostsv4 youtube.com | head -1 | grep -q "^0.0.0.0"'
chk "... for www.youtube.com, m.youtube.com, youtu.be, i.ytimg.com" 'for d in www.youtube.com m.youtube.com youtu.be i.ytimg.com googlevideo.com; do x getent ahostsv4 $d | head -1 | grep -q "^0.0.0.0" || exit 1; done'
chk "IPv6 sink line ':: www.youtube.com' is present" 'hosts | grep -qx ":: www.youtube.com"'
chk "unrelated names untouched (localhost still 127.0.0.1)" 'x getent ahostsv4 localhost | head -1 | grep -q "^127.0.0.1"'
chk "original hosts entries preserved byte for byte" '[ "$(hosts | sed "/BEGIN HOURKEEP/,/END HOURKEEP/d")" = "$ORIG" ]'
chk "daemon logged the write method (Docker bind mount => in-place fallback)" 'x journalctl -u hourkeepd --no-pager -o cat | grep -q "applied rules.*method=in-place"'
chk "list shows the rule" 'xu member "hourkeep list" | grep -Eq "youtube +group"'
chk "status counts 1 rule and 0 tamper events" 'xu member "hourkeep status --json" | grep -q "\"ruleCount\":1" && xu member "hourkeep status --json" | grep -q "\"tamperCount\":0"'
BLOCKED=$(hosts)

echo "=== 3. tamper is reverted within the reconcile interval (${INTERVAL}s)"
# Each case damages only the managed block, then waits for the file to be byte-identical again.
case_restored() { # name, command to run in the container
  x sh -c "$2"
  local t; t=$(wait_until $((INTERVAL + 3)) '[ "$(hosts)" = "$BLOCKED" ]'); local rc=$?
  chk "$1: restored in ${t}s (limit $((INTERVAL + 2))s)" "[ $rc -eq 0 ] && [ $t -le $((INTERVAL + 2)) ]"
}
case_restored "whole block deleted" "sed '/BEGIN HOURKEEP/,/END HOURKEEP/d' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"
chk "getent resolves to 0.0.0.0 again" 'x getent ahostsv4 youtube.com | head -1 | grep -q "^0.0.0.0"'
case_restored "one youtube.com line deleted" "grep -v ' youtube.com\$' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"
case_restored "address rewritten to 1.2.3.4" "sed 's/^0.0.0.0 youtube.com\$/1.2.3.4 youtube.com/' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"
case_restored "end marker removed (half-deleted block)" "grep -v 'END HOURKEEP' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"
case_restored "block commented out" "sed 's/^0.0.0.0 /#0.0.0.0 /' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"

x sh -c 'echo "127.0.0.1 localhost" > /etc/hosts'          # whole file overwritten: other entries are the user's loss, the block must return
t=$(wait_until $((INTERVAL + 3)) 'hosts | grep -q "0.0.0.0 youtube.com"'); rc=$?
chk "whole file overwritten: block comes back in ${t}s" '[ $rc -eq 0 ]'
printf '%s\n' "$ORIG" | docker exec -i $C sh -c 'cat > /tmp/orig'   # put the original non-block lines back, block removed
docker exec $C sh -c 'cat /tmp/orig > /etc/hosts'
t=$(wait_until $((INTERVAL + 3)) '[ "$(hosts)" = "$BLOCKED" ]'); rc=$?
chk "block re-added next to the restored original lines (${t}s)" '[ $rc -eq 0 ]'

x sh -c 'echo "10.9.9.9 my-own-entry" >> /etc/hosts'       # edits OUTSIDE the block are the user's business
sleep $((INTERVAL + 2))
chk "edits outside the block are left alone" 'hosts | grep -q "my-own-entry"'
x sh -c 'grep -v my-own-entry /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts'
chk "tamper events were recorded (>= 6)" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" -ge 6 ]'
chk "journal says tamper detected" 'x journalctl -u hourkeepd --no-pager -o cat | grep -q "tamper detected"'

echo "=== 4. restart, crash and persistence"
x systemctl restart hourkeepd; wait_active
chk "rules survive 'systemctl restart'" 'xu member "hourkeep list" | grep -Eq "youtube +group"'
chk "block still in place after restart" '[ "$(hosts)" = "$BLOCKED" ]'
pid=$(x systemctl show hourkeepd -p MainPID --value)
x kill -9 "$pid"; sleep 2; wait_active
chk "daemon restarted after SIGKILL (new pid)" '[ "$(x systemctl show hourkeepd -p MainPID --value)" != "$pid" ]'
chk "rules survive a crash" 'xu member "hourkeep list" | grep -Eq "youtube +group"'
TAMPERS=$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)
x systemctl stop hourkeepd
chk "stopping the daemon leaves the block in place" '[ "$(hosts)" = "$BLOCKED" ]'
x sh -c "sed '/BEGIN HOURKEEP/,/END HOURKEEP/d' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"   # block removed while the daemon is down
x systemctl start hourkeepd; wait_active
chk "on start the daemon re-applies stored rules immediately" '[ "$(hosts)" = "$BLOCKED" ]'
chk "...and does not count that as tampering" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" = "$TAMPERS" ]'

echo "=== 5. unblock and uninstall cleanup"
chk "unblock is instant" 'xu member "hourkeep unblock youtube" | grep -q "Unblocked youtube"'
chk "hosts file back to the original" '[ "$(hosts)" = "$ORIG" ]'
chk "no leftover temp files in /etc" '! x sh -c "ls -a /etc | grep -q hourkeep"'
xu member "hourkeep block example.com" >/dev/null
chk "plain domain blocks example.com and www.example.com" 'hosts | grep -q "0.0.0.0 example.com" && hosts | grep -q "0.0.0.0 www.example.com"'
chk "wildcard is refused with a clear error" 'xu member "hourkeep block \"*.googlevideo.com\"" 2>&1 | grep -q wildcards'
chk "unknown group is refused and lists known groups" 'xu member "hourkeep block tiktok" 2>&1 | grep -q "Known groups: youtube"'
x systemctl stop hourkeepd
x hourkeepd --teardown >/dev/null 2>&1
chk "'hourkeepd --teardown' removes the block" '[ "$(hosts)" = "$ORIG" ]'

echo "=== 6. hardening"
x systemctl start hourkeepd; wait_active
x systemctl show hourkeepd -p ProtectSystem -p NoNewPrivileges -p PrivateTmp -p ProtectHome -p CapabilityBoundingSet | sed 's/^/  /'
x systemd-analyze security hourkeepd --no-pager 2>&1 | tail -1 | sed 's/^/  /'
chk "still works under the hardened unit" 'xu member "hourkeep block youtube" | grep -q Blocked'

echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
