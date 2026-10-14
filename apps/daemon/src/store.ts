import { DatabaseSync } from 'node:sqlite';
import type { Rule } from '@hourkeep/core';

export interface Migration {
  readonly version: number;
  readonly up: string;
  /** Reverts `up`. Provided where practical so a downgrade can be tested. */
  readonly down: string;
}

/** Append-only. Never edit a shipped migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE rules (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('domain', 'group')),
        target     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (kind, target)
      ) STRICT;
      CREATE TABLE events (
        id      INTEGER PRIMARY KEY,
        ts      INTEGER NOT NULL,
        type    TEXT NOT NULL,
        uid     INTEGER,
        payload TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX events_type_ts ON events (type, ts);
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `,
    down: `
      DROP TABLE meta;
      DROP INDEX events_type_ts;
      DROP TABLE events;
      DROP TABLE rules;
    `,
  },
];

export class SchemaTooNewError extends Error {}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Bring `db` to `target` (default: latest), one transaction per step. */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  target = migrations[migrations.length - 1]?.version ?? 0,
): void {
  const current = userVersion(db);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (current > latest) {
    throw new SchemaTooNewError(
      `database schema v${current} is newer than this daemon supports (v${latest})`,
    );
  }
  const step = (sql: string, version: number): void => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  if (target >= current) {
    for (const m of migrations)
      if (m.version > current && m.version <= target) step(m.up, m.version);
  } else {
    for (const m of [...migrations].reverse()) {
      if (m.version <= current && m.version > target) step(m.down, m.version - 1);
    }
  }
}

export interface StoredRule extends Rule {
  readonly createdAt: number;
}

export type EventType =
  'daemon_start' | 'rule_added' | 'rule_removed' | 'tamper' | 'reconcile_error';

/** Durable state: rules and the event log. All timestamps are epoch milliseconds. */
export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed) and migrate. Use `:memory:` for tests. */
  static open(file: string): Store {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    migrate(db);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    return userVersion(this.db);
  }

  listRules(): StoredRule[] {
    const rows = this.db
      .prepare('SELECT kind, target, created_at FROM rules ORDER BY id')
      .all() as { kind: 'domain' | 'group'; target: string; created_at: number }[];
    return rows.map((r) => ({ kind: r.kind, target: r.target, createdAt: r.created_at }));
  }

  /** Returns the stored rule and whether it was newly created. */
  addRule(rule: Rule, now: number): { rule: StoredRule; added: boolean } {
    const res = this.db
      .prepare(
        'INSERT INTO rules (kind, target, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, target) DO NOTHING',
      )
      .run(rule.kind, rule.target, now, now);
    const row = this.db
      .prepare('SELECT created_at FROM rules WHERE kind = ? AND target = ?')
      .get(rule.kind, rule.target) as { created_at: number };
    return {
      rule: { kind: rule.kind, target: rule.target, createdAt: row.created_at },
      added: Number(res.changes) > 0,
    };
  }

  removeRule(rule: Rule): boolean {
    const res = this.db
      .prepare('DELETE FROM rules WHERE kind = ? AND target = ?')
      .run(rule.kind, rule.target);
    return Number(res.changes) > 0;
  }

  recordEvent(type: EventType, ts: number, uid: number | null, payload: object = {}): void {
    this.db
      .prepare('INSERT INTO events (ts, type, uid, payload) VALUES (?, ?, ?, ?)')
      .run(ts, type, uid, JSON.stringify(payload));
  }

  countEvents(type: EventType): number {
    const row = this.db.prepare('SELECT count(*) AS c FROM events WHERE type = ?').get(type) as {
      c: number;
    };
    return Number(row.c);
  }

  lastEventTs(type: EventType): number | null {
    const row = this.db.prepare('SELECT max(ts) AS t FROM events WHERE type = ?').get(type) as {
      t: number | null;
    };
    return row.t === null ? null : Number(row.t);
  }

  events(type: EventType): { ts: number; uid: number | null; payload: unknown }[] {
    const rows = this.db
      .prepare('SELECT ts, uid, payload FROM events WHERE type = ? ORDER BY id')
      .all(type) as { ts: number; uid: number | null; payload: string }[];
    return rows.map((r) => ({ ts: r.ts, uid: r.uid, payload: JSON.parse(r.payload) as unknown }));
  }
}
