'use strict';
// Exercises the SQLite features Hourkeep needs with either driver.
// usage: node driver-test.cjs node-sqlite|better-sqlite3 [nativeBindingPath]
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function open(kind, file, nativeBinding) {
  if (kind === 'node-sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file);
  }
  const Database = require('better-sqlite3');
  if (!nativeBinding) return new Database(file);
  // Inside a SEA, require() only resolves built-ins, so load the addon with process.dlopen
  // and hand the loaded object to better-sqlite3.
  const mod = { exports: {} };
  process.dlopen(mod, nativeBinding);
  return new Database(file, { nativeBinding: mod.exports });
}

function run(kind, nativeBinding) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-sqlite-'));
  const file = path.join(dir, 'test.db');
  const out = { kind, checks: {} };
  const db = open(kind, file, nativeBinding);
  const check = (name, fn) => {
    try {
      out.checks[name] = fn();
    } catch (e) {
      out.checks[name] = 'FAIL: ' + e.message;
    }
  };
  const pragma = (sql) => {
    // node:sqlite has no .pragma(); better-sqlite3 has both.
    const row = db.prepare('PRAGMA ' + sql).get();
    return row && Object.values(row)[0];
  };

  check('sqlite_version', () => db.prepare('select sqlite_version() v').get().v);
  check('wal', () => {
    db.exec('PRAGMA journal_mode = WAL');
    return pragma('journal_mode');
  });
  check('foreign_keys', () => {
    db.exec('PRAGMA foreign_keys = ON');
    return pragma('foreign_keys');
  });
  check('strict_table', () => {
    db.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT) STRICT',
    );
    try {
      db.prepare('INSERT INTO events (ts, type) VALUES (?, ?)').run('not-int', 'x');
      return 'strict NOT enforced';
    } catch {
      return 'strict enforced';
    }
  });
  check('user_version_migration', () => {
    db.exec('PRAGMA user_version = 3');
    return pragma('user_version');
  });
  check('json_functions', () => {
    db.prepare('INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)').run(
      1,
      'block',
      JSON.stringify({ domain: 'youtube.com' }),
    );
    return db
      .prepare("SELECT json_extract(payload, '$.domain') d FROM events WHERE type = 'block'")
      .get().d;
  });
  check('transaction_rollback', () => {
    db.exec('BEGIN');
    db.prepare('INSERT INTO events (ts, type) VALUES (?, ?)').run(2, 'a');
    db.exec('ROLLBACK');
    return db.prepare('SELECT count(*) c FROM events').get().c; // expect 1
  });
  check('bulk_insert_10k_ms', () => {
    const ins = db.prepare('INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)');
    const t0 = process.hrtime.bigint();
    db.exec('BEGIN');
    for (let i = 0; i < 10000; i++) ins.run(i, 'bulk', '{}');
    db.exec('COMMIT');
    return Number((process.hrtime.bigint() - t0) / 1000000n);
  });
  check('bigint_roundtrip', () => {
    const v = db.prepare('SELECT 9007199254740993 AS big').get().big;
    return typeof v + ':' + String(v);
  });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const [kind, nativeBinding] = process.argv.slice(2);
console.log(JSON.stringify(run(kind, nativeBinding), null, 1));
