import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeSchedule } from '@hourkeep/core';
import { MIGRATIONS, SchemaTooNewError, Store, migrate } from './store.js';

const version = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const TABLES = ['events', 'meta', 'passes', 'pending_changes', 'rules', 'settings'];
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
    expect(tables(db)).toEqual(TABLES);
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
    expect(tables(db)).toEqual(TABLES);
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

describe('migration v1 to v2', () => {
  it('keeps existing rules and events, and gives rules no schedule and no limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-mig-'));
    try {
      const file = path.join(dir, 'db');
      const old = new DatabaseSync(file);
      migrate(old, MIGRATIONS, 1); // a database as M1 left it
      old.exec(
        "INSERT INTO rules (kind, target, created_at, updated_at) VALUES ('group', 'youtube', 100, 100), ('domain', 'reddit.com', 200, 200)",
      );
      old.exec("INSERT INTO events (ts, type, uid, payload) VALUES (5, 'tamper', NULL, '{}')");
      expect(version(old)).toBe(1);
      old.close();

      const s = Store.open(file);
      expect(s.schemaVersion).toBe(MIGRATIONS.length);
      expect(s.listRules()).toEqual([
        {
          kind: 'group',
          target: 'youtube',
          createdAt: 100,
          schedule: null,
          dailyLimitMinutes: null,
        },
        {
          kind: 'domain',
          target: 'reddit.com',
          createdAt: 200,
          schedule: null,
          dailyLimitMinutes: null,
        },
      ]);
      expect(s.countEvents('tamper')).toBe(1);
      expect(s.openPending()).toEqual([]);
      s.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be rolled back to v1 without losing rules', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec(
      "INSERT INTO rules (kind, target, created_at, updated_at, daily_limit_minutes) VALUES ('group', 'youtube', 1, 1, 30)",
    );
    migrate(db, MIGRATIONS, 1);
    expect(version(db)).toBe(1);
    expect(tables(db)).toEqual(['events', 'meta', 'rules']);
    expect(
      (db.prepare('SELECT target FROM rules').all() as { target: string }[]).map((r) => r.target),
    ).toEqual(['youtube']);
  });
});

describe('Store: schedules, limits, settings', () => {
  const rule = { kind: 'group', target: 'youtube' } as const;
  const sched = makeSchedule('Asia/Kolkata', { mon: [{ start: 540, end: 1020 }] });

  it('stores and clears a schedule and a limit', () => {
    const s = Store.open(':memory:');
    s.addRule(rule, 1);
    if (!sched.ok) throw new Error(sched.error);
    s.setSchedule(rule, sched.value, 2);
    s.setLimit(rule, 30, 2);
    expect(s.getRule(rule)).toMatchObject({ schedule: sched.value, dailyLimitMinutes: 30 });
    s.setSchedule(rule, null, 3);
    s.setLimit(rule, null, 3);
    expect(s.getRule(rule)).toMatchObject({ schedule: null, dailyLimitMinutes: null });
    expect(s.getRule({ kind: 'domain', target: 'nope.example' })).toBeNull();
  });

  it('treats a corrupt stored schedule as always blocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-bad-'));
    try {
      const file = path.join(dir, 'db');
      const s = Store.open(file);
      s.addRule(rule, 1);
      s.close();
      const raw = Store.openRaw(file);
      raw.exec("UPDATE rules SET schedule = '{not json'");
      raw.close();
      const again = Store.open(file);
      expect(again.getRule(rule)?.schedule).toBeNull();
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds a setting once but overwrites on set', () => {
    const s = Store.open(':memory:');
    s.seedSetting('cooldown_seconds', '600');
    s.seedSetting('cooldown_seconds', '5');
    expect(s.settings()).toEqual({ cooldown_seconds: '600' });
    s.setSetting('cooldown_seconds', '1200');
    expect(s.settings()).toEqual({ cooldown_seconds: '1200' });
  });
});

describe('Store: pending changes and passes', () => {
  const base = {
    kind: 'remove_rule',
    payload: { kind: 'remove_rule', rule: { kind: 'group', target: 'youtube' } },
    summary: 'stop blocking youtube',
    requestedByUid: 1000,
    requestedAt: 10,
    cooldownEndsAt: 610,
    expiresAt: 1810,
    attemptsLeft: 3,
  };

  it('creates, reads and resolves pending changes', () => {
    const s = Store.open(':memory:');
    const id = s.createPending(base);
    expect(s.getPending(id)).toMatchObject({
      id,
      status: 'pending',
      summary: base.summary,
      payload: base.payload,
      challenge: null,
      attemptsLeft: 3,
    });
    expect(s.openPending()).toHaveLength(1);
    s.setAttempts(id, 1);
    expect(s.getPending(id)?.attemptsLeft).toBe(1);
    s.resolvePending(id, 'applied', 700);
    expect(s.openPending()).toEqual([]);
    expect(s.getPending(id)?.status).toBe('applied');
    s.resolvePending(id, 'cancelled', 800); // a resolved change cannot be resolved again
    expect(s.getPending(id)?.status).toBe('applied');
  });

  it('stores the challenge with its secret and drops it when resolved', () => {
    const s = Store.open(':memory:');
    const id = s.createPending(base);
    const issued = {
      public: {
        id: 'abcd1234',
        issuedAt: 1,
        earliestAnswerAt: 6,
        instructions: 'x',
        data: { kind: 'typing' as const, text: 'aaa' },
      },
      secret: { kind: 'typing' as const, text: 'aaa' },
    };
    s.setChallenge(id, issued, 3);
    expect(s.getPending(id)?.challenge).toEqual(issued);
    s.resolvePending(id, 'cancelled', 5);
    expect(s.getPending(id)?.challenge).toBeNull();
  });

  it('records passes, finds the active ones and lets them end early', () => {
    const s = Store.open(':memory:');
    const id = s.addPass({
      kind: 'group',
      target: 'youtube',
      dayKey: '2026-10-14',
      startsAt: 100,
      endsAt: 1100,
      uid: 1000,
    });
    expect(s.activePasses(99)).toEqual([]);
    expect(s.activePasses(100)).toHaveLength(1);
    expect(s.activePasses(1099)).toHaveLength(1);
    expect(s.activePasses(1100)).toEqual([]);
    expect(s.passesOnDay('2026-10-14')).toHaveLength(1);
    expect(s.passesOnDay('2026-10-15')).toEqual([]);
    s.endPass(id, 500);
    expect(s.activePasses(600)).toEqual([]);
    expect(s.passesOnDay('2026-10-14')[0]?.endedAt).toBe(500);
    s.endPass(id, 900); // already ended: unchanged
    expect(s.passesOnDay('2026-10-14')[0]?.endedAt).toBe(500);
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
      expect(b.listRules()).toEqual([
        { kind: 'group', target: 'youtube', createdAt: 5, schedule: null, dailyLimitMinutes: null },
      ]);
      expect(b.schemaVersion).toBe(MIGRATIONS.length);
      b.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
