#!/bin/sh
# Runs inside the container.
set -u
echo "== addon size: $(stat -c %s /opt/peercred/peercred.node) bytes; needs only libc: $(ldd /opt/peercred/peercred.node | tr '\n' ' ')"
start() { node server.cjs >/tmp/server.log 2>&1 & SP=$!; sleep 1; }
stop() { kill $SP 2>/dev/null; wait $SP 2>/dev/null; }

echo; echo "== 1. plain node server. client as root, then as member (uid 1001)"
start
node client.cjs
su member -c "node /spike/client.cjs"
echo "-- fire-and-forget client (exits before the server inspects it)"
su member -c "node /spike/client.cjs --fire-and-forget"; sleep 1
tail -n 1 /tmp/server.log
stop

echo; echo "== 2. same server as SEA binary (addon is a sidecar loaded with process.dlopen)"
cat > /tmp/sea.json <<JSON
{ "main": "/spike/server.cjs", "output": "/tmp/server.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config /tmp/sea.json >/dev/null
cp "$(command -v node)" /tmp/server-sea
/opt/tools/node_modules/.bin/postject /tmp/server-sea NODE_SEA_BLOB /tmp/server.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null 2>&1
/tmp/server-sea >/tmp/server.log 2>&1 & SP=$!; sleep 1
su member -c "node /spike/client.cjs"
stop

echo; echo "== 3. latency of each method (50 connections)"
start
node -e '
const net=require("net");let n=0,a=[],s=[];
function one(){const c=net.connect("/tmp/pc.sock");let b="";c.on("data",d=>b+=d);c.on("end",()=>{const r=JSON.parse(b);a.push(r.addon.us);s.push(r.ss.us);if(++n<50)one();else{const med=x=>x.sort((p,q)=>p-q)[x.length>>1];console.log("addon median us:",med(a),"  ss median us:",med(s));process.exit(0)}});c.write("x\n")}
one()'
stop
