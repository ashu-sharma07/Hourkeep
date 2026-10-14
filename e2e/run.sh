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
chk "list shows the rule" 'xu member "hourkeep list" | grep -Eq "youtube +\(group\)"'
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
chk "rules survive 'systemctl restart'" 'xu member "hourkeep list" | grep -Eq "youtube +\(group\)"'
chk "block still in place after restart" '[ "$(hosts)" = "$BLOCKED" ]'
pid=$(x systemctl show hourkeepd -p MainPID --value)
x kill -9 "$pid"; sleep 2; wait_active
chk "daemon restarted after SIGKILL (new pid)" '[ "$(x systemctl show hourkeepd -p MainPID --value)" != "$pid" ]'
chk "rules survive a crash" 'xu member "hourkeep list" | grep -Eq "youtube +\(group\)"'
TAMPERS=$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)
x systemctl stop hourkeepd
chk "stopping the daemon leaves the block in place" '[ "$(hosts)" = "$BLOCKED" ]'
x sh -c "sed '/BEGIN HOURKEEP/,/END HOURKEEP/d' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts"   # block removed while the daemon is down
x systemctl start hourkeepd; wait_active
chk "on start the daemon re-applies stored rules immediately" '[ "$(hosts)" = "$BLOCKED" ]'
chk "...and does not count that as tampering" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" = "$TAMPERS" ]'

# ---- helpers for the friction flow ----------------------------------------------------------
# Request id from a JSON outcome: {"ok":true,"data":{"status":"pending","change":{"id":N,...}}}
req_id() { grep -o '"id":[0-9]*' | head -1 | cut -d: -f2; }
# Do what a person does: read the challenge, answer it. Challenge waits in this image are 1-2 s.
confirm_as() { # user id
  local ch ans
  ch=$(xu "$1" "hourkeep confirm $2 --json") || { echo "$ch"; return 1; }
  ans=$(printf '%s' "$ch" | python3 e2e/solve.py) || return 1
  sleep 3
  xu "$1" "hourkeep confirm $2 --answer '$ans'"
}
cooldown() { sleep 4; }   # the image seeds a 3 second cooldown
real_pending() { xu member "hourkeep --json pending" | grep -o '"id":[0-9]*' | wc -l; }

echo "=== 5. loosening needs cooldown and challenge; tightening does not"
out=$(xu member "hourkeep unblock youtube")
id=$(xu member "hourkeep --json unblock youtube" | req_id)
chk "unblock does not unblock: it explains the cooldown" 'echo "$out" | grep -q "does not happen yet"'
chk "the block is still in place right after 'unblock'" '[ "$(hosts)" = "$BLOCKED" ]'
chk "asking again returns the same pending change (one open request)" '[ "$(real_pending)" = 1 ]'
chk "pending lists it with a cooldown" 'xu member "hourkeep pending" | grep -q "stop blocking youtube"'
chk "confirming before the cooldown ends is refused" 'xu member "hourkeep confirm $id --json" | grep -q cooldown_active'
chk "still blocked after the refused attempt" '[ "$(hosts)" = "$BLOCKED" ]'
chk "a wrong answer does not unblock" 'cooldown; xu member "hourkeep confirm $id --json" >/dev/null; sleep 3; xu member "hourkeep confirm $id --answer nonsense" | grep -q "Wrong"; [ "$(hosts)" = "$BLOCKED" ]'
chk "cancelling works and the id is dead afterwards" 'xu member "hourkeep pending cancel $id" | grep -q Cancelled && ! xu member "hourkeep confirm $id" >/dev/null 2>&1'
chk "cancelled request left the block in place" '[ "$(hosts)" = "$BLOCKED" ]'
chk "nothing is pending after the cancel" '[ "$(real_pending)" = 0 ]'

id=$(xu member "hourkeep --json unblock youtube" | req_id)
cooldown
chk "after the cooldown the right answer applies the change" 'confirm_as member $id | grep -q "Stopped blocking youtube"'
chk "hosts file back to the original" '[ "$(hosts)" = "$ORIG" ]'
chk "the same id cannot be used twice" '! xu member "hourkeep confirm $id --answer x" >/dev/null 2>&1'
chk "no leftover temp files in /etc" '! x sh -c "ls -a /etc | grep -q hourkeep"'
chk "an outsider cannot request or confirm anything" '! xu outsider "hourkeep unblock youtube" >/dev/null 2>&1'
chk "the database and its challenge answers are not readable by users" '! xu member "cat /var/lib/hourkeep/hourkeep.db" >/dev/null 2>&1'

xu member "hourkeep block example.com" >/dev/null
chk "plain domain blocks example.com and www.example.com" 'hosts | grep -q "0.0.0.0 example.com" && hosts | grep -q "0.0.0.0 www.example.com"'
chk "wildcard is refused with a clear error" 'xu member "hourkeep block \"*.googlevideo.com\"" 2>&1 | grep -q wildcards'
chk "unknown group is refused and lists known groups" 'xu member "hourkeep block tiktok" 2>&1 | grep -q "Known groups: youtube"'
xu member "hourkeep block youtube" >/dev/null

echo "=== 6. pending changes survive restarts, even mid-challenge"
id=$(xu member "hourkeep --json unblock example.com" | req_id)
x systemctl restart hourkeepd; wait_active
chk "a request made before a restart is still pending after it" 'xu member "hourkeep pending" | grep -q "stop blocking example.com"'
cooldown
ch1=$(xu member "hourkeep confirm $id --json")
x systemctl restart hourkeepd; wait_active
ch2=$(xu member "hourkeep confirm $id --json")
chk "the same challenge is returned after a restart" '[ "$ch1" = "$ch2" ]'
LEAKS=$(printf '%s' "$ch1" | grep -c '"secret"\|"answers"')
chk "the challenge JSON shows no answer field" '[ "$LEAKS" = 0 ]'
chk "and it can still be answered" 'sleep 3; ans=$(printf "%s" "$ch2" | python3 e2e/solve.py); xu member "hourkeep confirm $id --answer \"$ans\"" | grep -q "Stopped blocking example.com"'
chk "example.com is unblocked, youtube still blocked" '! hosts | grep -q example.com && [ "$(hosts)" != "$ORIG" ]'

echo "=== 7. schedules follow the real clock"
HOUR=$(date -u +%H); MIN=$(date -u +%M)
# a window that does not include now: starts 2 hours from now, lasts one hour (UTC)
S=$(printf '%02d:%02d' $(( (10#$HOUR + 2) % 24 )) $((10#$MIN))); E=$(printf '%02d:%02d' $(( (10#$HOUR + 3) % 24 )) $((10#$MIN)))
TAMP=$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)
sid=$(xu member "hourkeep --json schedule set youtube 'daily $S-$E' --tz UTC" | req_id)
chk "a schedule that shrinks coverage is a pending change, not applied" '[ -n "$sid" ] && hosts | grep -q "0.0.0.0 youtube.com"'
cooldown
chk "confirming applies it" 'confirm_as member $sid | grep -q "Schedule of youtube is now"'
t=$(wait_until $((INTERVAL + 3)) '! hosts | grep -q "0.0.0.0 youtube.com"'); rc=$?
chk "outside its window the block is lifted (${t}s)" '[ $rc -eq 0 ]'
chk "list says it is not blocking now" 'xu member "hourkeep list" | grep -q "not blocking now"'
chk "that lifting was not counted as tampering" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" = "$TAMP" ]'
chk "widening the schedule is instant and blocks again" 'xu member "hourkeep schedule set youtube \"daily 00:00-24:00\" --tz UTC" | grep -q "Schedule of youtube is now" && hosts | grep -q "0.0.0.0 youtube.com"'
# a window that opens two minutes from now: the block must appear by itself at that moment
NEXT=$(date -u -d '+2 minutes' +%H:%M); END=$(date -u -d '+62 minutes' +%H:%M)
sid=$(xu member "hourkeep --json schedule set youtube 'daily $NEXT-$END' --tz UTC" | req_id)
cooldown; confirm_as member $sid >/dev/null
wait_until $((INTERVAL + 3)) '! hosts | grep -q "0.0.0.0 youtube.com"' >/dev/null   # lifted until the window opens
t=$(wait_until 135 'hosts | grep -q "0.0.0.0 youtube.com"'); rc=$?
chk "when its window opens the block appears by itself (${t}s)" '[ $rc -eq 0 ]'
chk "...still without any tamper event" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" = "$TAMP" ]'
chk "clearing the schedule is instant" 'xu member "hourkeep schedule clear youtube" | grep -qi always'

echo "=== 8. temporary passes and daily limits"
out=$(xu member "hourkeep pass start youtube --no-confirm")
pid=$(xu member "hourkeep --json pass start youtube" | req_id)
chk "a pass is requested, not granted" 'echo "$out" | grep -q "ready now" && hosts | grep -q "0.0.0.0 youtube.com"'
chk "a pass is ready at once (no cooldown) but needs the challenge" 'xu member "hourkeep confirm $pid --json" | grep -q "\"challenge\""'
chk "answering the challenge suspends the block" 'sleep 3; ch=$(xu member "hourkeep confirm $pid --json"); ans=$(printf "%s" "$ch" | python3 e2e/solve.py); sleep 3; xu member "hourkeep confirm $pid --answer \"$ans\"" | grep -q "Pass started on youtube for 1m"; ! hosts | grep -q "0.0.0.0 youtube.com"'
chk "list shows the running pass" 'xu member "hourkeep list" | grep -q "pass running"'
chk "status counts the pass" 'xu member "hourkeep status" | grep -q "Passes today:      1 of 3 used"'
chk "other rules keep blocking during a pass" 'xu member "hourkeep block reddit.com" >/dev/null; hosts | grep -q "0.0.0.0 reddit.com"'
TAMP=$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)
t=$(wait_until 85 'hosts | grep -q "0.0.0.0 youtube.com"'); rc=$?
chk "the pass runs out by itself and the block returns (${t}s)" '[ $rc -eq 0 ]'
chk "...without a tamper event" '[ "$(xu member "hourkeep status --json" | grep -o "\"tamperCount\":[0-9]*" | cut -d: -f2)" = "$TAMP" ]'

chk "ending a pass early is instant" 'p=$(xu member "hourkeep --json pass start youtube" | req_id); ch=$(xu member "hourkeep confirm $p --json"); ans=$(printf "%s" "$ch" | python3 e2e/solve.py); sleep 3; xu member "hourkeep confirm $p --answer \"$ans\"" >/dev/null; ! hosts | grep -q "0.0.0.0 youtube.com" && xu member "hourkeep pass end youtube" | grep -q "Blocking again" && hosts | grep -q "0.0.0.0 youtube.com"'
chk "a limit of 0 forbids passes for the rule (lowering is instant)" 'xu member "hourkeep limit set youtube 0" | grep -q "now 0 minutes" && xu member "hourkeep pass start youtube --no-confirm" 2>&1 | grep -q "no passes"'
chk "removing a limit is loosening: it waits" 'xu member "hourkeep limit clear youtube" | grep -q "does not happen yet"'
for i in $(xu member "hourkeep --json pending" | grep -o '"id":[0-9]*' | cut -d: -f2); do xu member "hourkeep pending cancel $i" >/dev/null; done
chk "a rule with its limit left alone still blocks" '[ "$(real_pending)" = 0 ] && hosts | grep -q "0.0.0.0 youtube.com"'

echo "=== 9. the cooldown is itself protected"
chk "raising the cooldown is instant" 'xu member "hourkeep settings set cooldown 2" | grep -q Updated && xu member "hourkeep settings" | grep -q "cooldown:        2 minutes"'
chk "a new request now waits two minutes" 'xu member "hourkeep unblock reddit.com" | grep -q "Wait 1m\|Wait 2m"'
chk "shortening the cooldown is itself a pending change" 'xu member "hourkeep settings set cooldown 1" | grep -q "does not happen yet" && xu member "hourkeep settings" | grep -q "cooldown:        2 minutes"'
chk "changing the timezone is loosening too" 'xu member "hourkeep settings set timezone Asia/Tokyo" | grep -q "does not happen yet"'
for i in $(xu member "hourkeep --json pending" | grep -o '"id":[0-9]*' | cut -d: -f2); do xu member "hourkeep pending cancel $i" >/dev/null; done

echo "=== 10. uninstall cleanup"
x systemctl stop hourkeepd
x hourkeepd --teardown >/dev/null 2>&1
chk "'hourkeepd --teardown' removes the block" '[ "$(hosts)" = "$ORIG" ]'

echo "=== 11. hardening"
x systemctl start hourkeepd; wait_active
x systemctl show hourkeepd -p ProtectSystem -p NoNewPrivileges -p PrivateTmp -p ProtectHome -p CapabilityBoundingSet | sed 's/^/  /'
x systemd-analyze security hourkeepd --no-pager 2>&1 | tail -1 | sed 's/^/  /'
chk "still works under the hardened unit" 'xu member "hourkeep block hardening-check.example" | grep -q "Blocked hardening-check.example"'

echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
