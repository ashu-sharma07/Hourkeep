'use strict';
// Spike 3: how can a Node daemon learn the UID of a Unix-socket peer?
//   A) SO_PEERCRED via a tiny N-API addon (loaded with process.dlopen so it also works in a SEA)
//   B) Pure Node/userland: fstat the accepted socket for its inode, then ask `ss -xpe` who owns the peer
const net = require('node:net');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SOCK = process.env.SOCK || '/tmp/pc.sock';
const ADDON = process.env.ADDON || '/opt/peercred/peercred.node';
const mod = { exports: {} };
let addonErr = null;
try {
  process.dlopen(mod, ADDON);
} catch (e) {
  addonErr = e.message;
}

function viaAddon(fd) {
  if (addonErr) return { error: 'addon: ' + addonErr };
  try {
    return mod.exports.getPeerCred(fd);
  } catch (e) {
    return { error: e.message };
  }
}

function viaSs(fd) {
  // B) Inode of our end of the connection, then look up the peer inode and its owner in `ss`.
  //    ss -xape line: u_str ESTAB 0 0 /tmp/pc.sock 9001 * 9000 users:(("node",pid=12,fd=3)) ... uid:1001
  try {
    const ino = fs.fstatSync(fd).ino; // socket inode as shown in the Local Address column
    const lines = execFileSync('ss', ['-xapne', '-H'], { encoding: 'utf8' }).split('\n');
    const cols = (l) => l.match(/^\S+\s+\S+\s+\d+\s+\d+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)(.*)$/);
    const mine = lines.map(cols).find((m) => m && Number(m[2]) === ino);
    if (!mine) return { error: 'connection not found in ss output' };
    const peerIno = Number(mine[4]);
    const peer = lines.map(cols).find((m) => m && Number(m[2]) === peerIno);
    if (!peer) return { error: 'peer socket not found in ss output (peer already gone?)' };
    const pid = peer[5].match(/pid=(\d+)/);
    const uid = peer[5].match(/uid:(\d+)/);
    return { pid: pid && Number(pid[1]), uid: uid && Number(uid[1]), peerIno };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  }
}

try {
  fs.unlinkSync(SOCK);
} catch {}
const server = net.createServer((conn) => {
  const fd = conn._handle.fd; // undocumented but present on Linux; verified here
  const t0 = process.hrtime.bigint();
  const a = viaAddon(fd);
  const ta = Number((process.hrtime.bigint() - t0) / 1000n);
  const t1 = process.hrtime.bigint();
  const b = viaSs(fd);
  const tb = Number((process.hrtime.bigint() - t1) / 1000n);
  const result = { fd, addon: { ...a, us: ta }, ss: { ...b, us: tb } };
  console.log(JSON.stringify(result));
  conn.on('error', () => {});
  conn.end(JSON.stringify(result) + '\n');
});
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o666); // the spike tests identity, not access control
  console.log('listening', SOCK);
});
process.on('SIGTERM', () => process.exit(0));
