#!/bin/bash
# Host-side driver. Everything that touches systemd runs inside the container.
set -u
C=hk-spike-daemon-test
IMG=hk-spike-daemon
x() { docker exec "$C" "$@"; }
pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
wait_active() { for _ in $(seq 40); do x systemctl is-active hourkeepd >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }

docker rm -f $C >/dev/null 2>&1
docker build -q -t $IMG . >/dev/null || exit 1
trap 'docker rm -f $C >/dev/null 2>&1' EXIT

docker run -d --name $C --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --cap-add SYS_ADMIN --security-opt apparmor=unconfined $IMG >/dev/null || exit 1
for _ in $(seq 40); do
  st=$(x systemctl is-system-running 2>/dev/null); case "$st" in running|degraded) break;; esac; sleep 0.5
done
echo "systemd state: $st"
[ "$(docker inspect -f '{{.State.Running}}' $C)" = true ] || { echo "container not running"; exit 1; }
wait_active

echo "--- environment"
x sh -c 'cat /etc/os-release | head -2; ldd --version | head -1; command -v node || echo "node: NOT installed"'
x ls -lh /usr/local/bin/hourkeepd

echo "--- 1. service starts as Type=notify and is active"
chk "unit active" 'x systemctl is-active hourkeepd | grep -qx active'
chk "no node binary on PATH" '[ "$(x sh -c "command -v node || echo none")" = none ]'
x systemctl show hourkeepd -p Type -p NotifyAccess -p WatchdogUSec -p MainPID

echo "--- 2. socket permissions"
x stat -c '%A %U:%G %n' /run/hourkeep/hourkeep.sock
chk "socket is 0660 root:hourkeep" '[ "$(x stat -c "%a %U:%G" /run/hourkeep/hourkeep.sock)" = "660 root:hourkeep" ]'
chk "root can ping" 'x /usr/local/bin/hourkeepd --ping | grep -q "\"ok\":true"'
chk "group member can ping" 'x su member -c "/usr/local/bin/hourkeepd --ping" | grep -q "\"ok\":true"'
chk "outsider is denied" '! x su outsider -c "/usr/local/bin/hourkeepd --ping" 2>&1 >/dev/null; x su outsider -c "/usr/local/bin/hourkeepd --ping" 2>&1 | grep -q EACCES'
echo "ping response:"; x /usr/local/bin/hourkeepd --ping

echo "--- 3. node:sqlite inside SEA, warning silenced"
chk "daemon logged startup" 'x journalctl -u hourkeepd --no-pager | grep -q "listening on"'
chk "no ExperimentalWarning in journal" '! x journalctl -u hourkeepd --no-pager | grep -q ExperimentalWarning'
chk "atomic write under ProtectSystem=strict + ReadWritePaths=/etc" 'x /usr/local/bin/hourkeepd --ping | grep -q "\"atomicWrite\":\"ok\""'
chk "atomic write visible on real fs" 'x test -s /etc/hourkeep-spike.conf'

echo "--- 4. crash recovery (SIGKILL) and state persistence"
b1=$(x /usr/local/bin/hourkeepd --ping | sed 's/.*"boots":\([0-9]*\).*/\1/')
pid1=$(x systemctl show hourkeepd -p MainPID --value)
x kill -9 "$pid1"; sleep 1; wait_active; sleep 1
pid2=$(x systemctl show hourkeepd -p MainPID --value)
b2=$(x /usr/local/bin/hourkeepd --ping | sed 's/.*"boots":\([0-9]*\).*/\1/')
chk "restarted with new pid ($pid1 -> $pid2)" '[ "$pid1" != "$pid2" ] && [ "$pid2" != 0 ]'
chk "sqlite state survived restart (boots $b1 -> $b2)" '[ "$b2" -gt "$b1" ]'

echo "--- 5. watchdog (event loop hang -> systemd restarts)"
pid3=$(x systemctl show hourkeepd -p MainPID --value)
x kill -USR2 "$pid3"
for _ in $(seq 40); do p=$(x systemctl show hourkeepd -p MainPID --value); [ "$p" != "$pid3" ] && [ "$p" != 0 ] && break; sleep 0.5; done
chk "watchdog replaced hung process ($pid3 -> $p)" '[ "$p" != "$pid3" ] && [ "$p" != 0 ]'
wait_active
x journalctl -u hourkeepd --no-pager | grep -iE "watchdog" | tail -3

echo "--- 6. graceful stop"
x systemctl stop hourkeepd
chk "socket removed on stop" 'x test -d /run/hourkeep || true; ! x test -e /run/hourkeep/hourkeep.sock'
x systemctl start hourkeepd; wait_active

echo "--- 7. hardening score (systemd-analyze security)"
x systemd-analyze security hourkeepd --no-pager 2>&1 | tail -1
x systemctl show hourkeepd -p ProtectSystem -p NoNewPrivileges -p PrivateTmp -p ProtectHome

echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
