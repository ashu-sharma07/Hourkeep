'use strict';
// M0 spike 2: hello-world "hourkeepd" packaged as a Node SEA binary and run under systemd.
// Not product code. Demonstrates: node:sqlite inside SEA, Unix socket with 0660 root:hourkeep,
// Type=notify + watchdog (via the systemd-notify helper), atomic file write under ProtectSystem=strict.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SOCK = process.env.HK_SOCKET || '/run/hourkeep/hourkeep.sock';
const DB = process.env.HK_DB || '/var/lib/hourkeep/spike.db';
const ATOMIC_TARGET = process.env.HK_ATOMIC_TARGET || '/etc/hourkeep-spike.conf';

// ---- client mode: `hourkeepd --ping` ----
if (process.argv.includes('--ping')) {
  const c = net.connect(SOCK);
  c.on('connect', () => c.write(JSON.stringify({ v: 1, op: 'ping' }) + '\n'));
  c.on('data', (d) => {
    process.stdout.write(d);
    c.end();
  });
  c.on('error', (e) => {
    console.error('ping failed:', e.code || e.message);
    process.exit(1);
  });
  return;
}

// ---- sd_notify: Node cannot send AF_UNIX datagrams, so shell out to systemd-notify ----
function notify(...args) {
  if (!process.env.NOTIFY_SOCKET) return;
  spawn('systemd-notify', args, { stdio: 'ignore' }).on('error', (e) =>
    console.error('systemd-notify failed:', e.message),
  );
}

// ---- atomic write: temp file in same dir, fsync, rename ----
function atomicWrite(target, data) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

fs.mkdirSync(path.dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec(
  'CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, pid INTEGER NOT NULL) STRICT',
);
db.prepare('INSERT INTO boots (ts, pid) VALUES (?, ?)').run(Date.now(), process.pid);
const boots = () => db.prepare('SELECT count(*) AS c FROM boots').get().c;

let atomicResult;
try {
  atomicWrite(ATOMIC_TARGET, `# written by hourkeep spike at ${new Date().toISOString()}\n`);
  atomicResult = 'ok';
} catch (e) {
  atomicResult = `FAIL ${e.code}`;
}

if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => {
    buf += d;
    if (buf.length > 4096) return conn.destroy(); // size limit
    if (!buf.includes('\n')) return;
    let req;
    try {
      req = JSON.parse(buf);
    } catch {
      return conn.end(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
    }
    conn.end(
      JSON.stringify({
        ok: true,
        op: req.op,
        pid: process.pid,
        node: process.version,
        sqlite: db.prepare('select sqlite_version() v').get().v,
        boots: boots(),
        atomicWrite: atomicResult,
        // execArgv from the SEA config: should be empty of surprises
        execArgv: process.execArgv,
      }) + '\n',
    );
  });
  conn.on('error', () => {});
});

server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o660);
  try {
    execFileSync('chgrp', ['hourkeep', SOCK]); // real daemon would use process.getgid lookup / chown
  } catch (e) {
    console.error('chgrp failed', e.message);
  }
  console.log(
    `hourkeepd spike listening on ${SOCK}, boots=${boots()}, atomicWrite=${atomicResult}`,
  );
  notify('--ready', '--status=listening');
});

// ---- watchdog ----
const wdUsec = Number(process.env.WATCHDOG_USEC || 0);
if (wdUsec > 0) {
  const every = Math.max(100, Math.floor(wdUsec / 1000 / 2));
  setInterval(() => notify('WATCHDOG=1'), every).unref();
  console.log(`watchdog enabled: ping every ${every}ms`);
}

// Test hook: SIGUSR2 blocks the event loop so the watchdog must fire.
process.on('SIGUSR2', () => {
  console.log('SIGUSR2: simulating hang');
  for (;;);
});

function shutdown() {
  notify('--stopping');
  server.close();
  try {
    fs.unlinkSync(SOCK);
  } catch {}
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
