import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, SchemaTooNewError, Store, migrate } from './store.js';

const version = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe('migrations', () => {
  it('create the schema and set user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(['events', 'meta', 'rules']);
  });

  it('are idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    migrate(db);
    expect(version(db)).toBe(MIGRATIONS.length);
  });

  it('roll back to zero and forward again', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    migrate(db, MIGRATIONS, 0);
    expect(version(db)).toBe(0);
    expect(tables(db)).toEqual([]);
    migrate(db);
    expect(tables(db)).toEqual(['events', 'meta', 'rules']);
  });

  it('refuse a database from a newer daemon', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 999');
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
  });

  it('leave the previous version in place when a step fails', () => {
    const db = new DatabaseSync(':memory:');
    const bad = [
      { version: 1, up: 'CREATE TABLE a (x INTEGER) STRICT', down: 'DROP TABLE a' },
      { version: 2, up: 'CREATE TABLE b (x INTEGER) STRICT; THIS IS NOT SQL', down: '' },
    ];
    expect(() => migrate(db, bad)).toThrow();
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual(['a']);
  });
});

describe('Store', () => {
  const open = () => Store.open(':memory:');

  it('adds a rule once and reports whether it was new', () => {
    const s = open();
    const first = s.addRule({ kind: 'group', target: 'youtube' }, 1000);
    const again = s.addRule({ kind: 'group', target: 'youtube' }, 2000);
    expect(first).toMatchObject({ added: true, rule: { createdAt: 1000 } });
    expect(again).toMatchObject({ added: false, rule: { createdAt: 1000 } });
    expect(s.listRules()).toHaveLength(1);
  });

  it('keeps a group and a domain with the same target apart', () => {
    const s = open();
    s.addRule({ kind: 'group', target: 'x.com' }, 1);
    s.addRule({ kind: 'domain', target: 'x.com' }, 1);
    expect(s.listRules()).toHaveLength(2);
  });

  it('removes rules and says whether anything was removed', () => {
    const s = open();
    s.addRule({ kind: 'domain', target: 'a.example' }, 1);
    expect(s.removeRule({ kind: 'domain', target: 'a.example' })).toBe(true);
    expect(s.removeRule({ kind: 'domain', target: 'a.example' })).toBe(false);
    expect(s.listRules()).toEqual([]);
  });

  it('lists rules in insertion order', () => {
    const s = open();
    for (const t of ['c.example', 'a.example', 'b.example'])
      s.addRule({ kind: 'domain', target: t }, 1);
    expect(s.listRules().map((r) => r.target)).toEqual(['c.example', 'a.example', 'b.example']);
  });

  it('records, counts and reads back events', () => {
    const s = open();
    expect(s.countEvents('tamper')).toBe(0);
    expect(s.lastEventTs('tamper')).toBeNull();
    s.recordEvent('tamper', 100, null, { kind: 'removed' });
    s.recordEvent('tamper', 250, 1000, { kind: 'modified' });
    s.recordEvent('rule_added', 300, 1000);
    expect(s.countEvents('tamper')).toBe(2);
    expect(s.lastEventTs('tamper')).toBe(250);
    expect(s.events('tamper')).toEqual([
      { ts: 100, uid: null, payload: { kind: 'removed' } },
      { ts: 250, uid: 1000, payload: { kind: 'modified' } },
    ]);
  });

  it('rejects an invalid rule kind at the database level', () => {
    const s = open();
    expect(() => s.addRule({ kind: 'bogus' as 'domain', target: 'x.example' }, 1)).toThrow();
  });

  it('persists across close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-store-'));
    try {
      const file = path.join(dir, 'db');
      const a = Store.open(file);
      a.addRule({ kind: 'group', target: 'youtube' }, 5);
      a.close();
      const b = Store.open(file);
      expect(b.listRules()).toEqual([{ kind: 'group', target: 'youtube', createdAt: 5 }]);
      expect(b.schemaVersion).toBe(MIGRATIONS.length);
      b.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
