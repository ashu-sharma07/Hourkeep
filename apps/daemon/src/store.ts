import { DatabaseSync } from 'node:sqlite';
import { makeSchedule, type IssuedChallenge, type Rule, type WeeklySchedule } from '@hourkeep/core';

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
  {
    version: 2,
    up: `
      ALTER TABLE rules ADD COLUMN schedule TEXT;
      ALTER TABLE rules ADD COLUMN daily_limit_minutes INTEGER;
      CREATE TABLE pending_changes (
        id               INTEGER PRIMARY KEY,
        kind             TEXT NOT NULL,
        payload          TEXT NOT NULL,
        summary          TEXT NOT NULL,
        requested_by_uid INTEGER,
        requested_at     INTEGER NOT NULL,
        cooldown_ends_at INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'cancelled', 'expired')),
        resolved_at      INTEGER,
        challenge        TEXT,
        attempts_left    INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX pending_changes_status ON pending_changes (status);
      CREATE TABLE passes (
        id               INTEGER PRIMARY KEY,
        kind             TEXT NOT NULL,
        target           TEXT NOT NULL,
        day_key          TEXT NOT NULL,
        starts_at        INTEGER NOT NULL,
        ends_at          INTEGER NOT NULL,
        ended_at         INTEGER,
        requested_by_uid INTEGER
      ) STRICT;
      CREATE INDEX passes_day ON passes (day_key);
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `,
    down: `
      DROP TABLE settings;
      DROP INDEX passes_day;
      DROP TABLE passes;
      DROP INDEX pending_changes_status;
      DROP TABLE pending_changes;
      ALTER TABLE rules DROP COLUMN daily_limit_minutes;
      ALTER TABLE rules DROP COLUMN schedule;
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
  /** Null means the rule blocks around the clock. */
  readonly schedule: WeeklySchedule | null;
  /** Max pass minutes per day, or null for no per-rule limit. */
  readonly dailyLimitMinutes: number | null;
}

export type EventType =
  | 'daemon_start'
  | 'rule_added'
  | 'rule_removed'
  | 'schedule_changed'
  | 'limit_changed'
  | 'setting_changed'
  | 'change_requested'
  | 'change_cancelled'
  | 'change_applied'
  | 'change_expired'
  | 'challenge_issued'
  | 'challenge_failed'
  | 'pass_started'
  | 'pass_ended'
  | 'clock_jump'
  | 'tamper'
  | 'reconcile_error';

export type PendingStatus = 'pending' | 'applied' | 'cancelled' | 'expired';

export interface PendingRow {
  readonly id: number;
  readonly kind: string;
  /** The change to apply, as JSON-decoded by the caller. */
  readonly payload: unknown;
  readonly summary: string;
  readonly requestedByUid: number | null;
  readonly requestedAt: number;
  readonly cooldownEndsAt: number;
  readonly expiresAt: number;
  readonly status: PendingStatus;
  readonly challenge: IssuedChallenge | null;
  readonly attemptsLeft: number;
}

export interface PassRow {
  readonly id: number;
  readonly kind: 'domain' | 'group';
  readonly target: string;
  readonly dayKey: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly endedAt: number | null;
}

interface RuleRow {
  kind: 'domain' | 'group';
  target: string;
  created_at: number;
  schedule: string | null;
  daily_limit_minutes: number | null;
}

interface PendingDbRow {
  id: number;
  kind: string;
  payload: string;
  summary: string;
  requested_by_uid: number | null;
  requested_at: number;
  cooldown_ends_at: number;
  expires_at: number;
  status: PendingStatus;
  challenge: string | null;
  attempts_left: number;
}

interface PassDbRow {
  id: number;
  kind: 'domain' | 'group';
  target: string;
  day_key: string;
  starts_at: number;
  ends_at: number;
  ended_at: number | null;
}

/** A stored schedule that no longer validates blocks around the clock: fail closed. */
function readSchedule(json: string | null): WeeklySchedule | null {
  if (json === null) return null;
  try {
    const raw = JSON.parse(json) as { timezone: string; days: Record<string, never> };
    const r = makeSchedule(raw.timezone, raw.days);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

const toRule = (r: RuleRow): StoredRule => ({
  kind: r.kind,
  target: r.target,
  createdAt: Number(r.created_at),
  schedule: readSchedule(r.schedule),
  dailyLimitMinutes: r.daily_limit_minutes === null ? null : Number(r.daily_limit_minutes),
});

const toPending = (r: PendingDbRow): PendingRow => ({
  id: Number(r.id),
  kind: r.kind,
  payload: JSON.parse(r.payload) as unknown,
  summary: r.summary,
  requestedByUid: r.requested_by_uid === null ? null : Number(r.requested_by_uid),
  requestedAt: Number(r.requested_at),
  cooldownEndsAt: Number(r.cooldown_ends_at),
  expiresAt: Number(r.expires_at),
  status: r.status,
  challenge: r.challenge === null ? null : (JSON.parse(r.challenge) as IssuedChallenge),
  attemptsLeft: Number(r.attempts_left),
});

const toPass = (r: PassDbRow): PassRow => ({
  id: Number(r.id),
  kind: r.kind,
  target: r.target,
  dayKey: r.day_key,
  startsAt: Number(r.starts_at),
  endsAt: Number(r.ends_at),
  endedAt: r.ended_at === null ? null : Number(r.ended_at),
});

/** Durable state: rules, pending changes, passes, settings and the event log. Times are epoch ms. */
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

  /** For migration tests: open without migrating. */
  static openRaw(file: string): DatabaseSync {
    return new DatabaseSync(file);
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    return userVersion(this.db);
  }

  // ---- rules ----

  listRules(): StoredRule[] {
    const rows = this.db
      .prepare(
        'SELECT kind, target, created_at, schedule, daily_limit_minutes FROM rules ORDER BY id',
      )
      .all() as unknown as RuleRow[];
    return rows.map(toRule);
  }

  getRule(rule: Rule): StoredRule | null {
    const row = this.db
      .prepare(
        'SELECT kind, target, created_at, schedule, daily_limit_minutes FROM rules WHERE kind = ? AND target = ?',
      )
      .get(rule.kind, rule.target) as RuleRow | undefined;
    return row ? toRule(row) : null;
  }

  /** Returns the stored rule and whether it was newly created. */
  addRule(rule: Rule, now: number): { rule: StoredRule; added: boolean } {
    const res = this.db
      .prepare(
        'INSERT INTO rules (kind, target, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (kind, target) DO NOTHING',
      )
      .run(rule.kind, rule.target, now, now);
    const stored = this.getRule(rule) as StoredRule;
    return { rule: stored, added: Number(res.changes) > 0 };
  }

  removeRule(rule: Rule): boolean {
    const res = this.db
      .prepare('DELETE FROM rules WHERE kind = ? AND target = ?')
      .run(rule.kind, rule.target);
    return Number(res.changes) > 0;
  }

  setSchedule(rule: Rule, schedule: WeeklySchedule | null, now: number): void {
    this.db
      .prepare('UPDATE rules SET schedule = ?, updated_at = ? WHERE kind = ? AND target = ?')
      .run(schedule === null ? null : JSON.stringify(schedule), now, rule.kind, rule.target);
  }

  setLimit(rule: Rule, minutes: number | null, now: number): void {
    this.db
      .prepare(
        'UPDATE rules SET daily_limit_minutes = ?, updated_at = ? WHERE kind = ? AND target = ?',
      )
      .run(minutes, now, rule.kind, rule.target);
  }

  // ---- settings ----

  settings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** Insert only if absent. Used to seed defaults once. */
  seedSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
      .run(key, value);
  }

  // ---- pending changes ----

  createPending(p: {
    kind: string;
    payload: unknown;
    summary: string;
    requestedByUid: number | null;
    requestedAt: number;
    cooldownEndsAt: number;
    expiresAt: number;
    attemptsLeft: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO pending_changes
           (kind, payload, summary, requested_by_uid, requested_at, cooldown_ends_at, expires_at, status, attempts_left)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        p.kind,
        JSON.stringify(p.payload),
        p.summary,
        p.requestedByUid,
        p.requestedAt,
        p.cooldownEndsAt,
        p.expiresAt,
        p.attemptsLeft,
      );
    return Number(res.lastInsertRowid);
  }

  getPending(id: number): PendingRow | null {
    const row = this.db.prepare('SELECT * FROM pending_changes WHERE id = ?').get(id) as
      PendingDbRow | undefined;
    return row ? toPending(row) : null;
  }

  /** Changes still waiting (not applied, cancelled or expired), oldest first. */
  openPending(): PendingRow[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_changes WHERE status = 'pending' ORDER BY id")
      .all() as unknown as PendingDbRow[];
    return rows.map(toPending);
  }

  setChallenge(id: number, challenge: IssuedChallenge | null, attemptsLeft: number): void {
    this.db
      .prepare('UPDATE pending_changes SET challenge = ?, attempts_left = ? WHERE id = ?')
      .run(challenge === null ? null : JSON.stringify(challenge), attemptsLeft, id);
  }

  setAttempts(id: number, attemptsLeft: number): void {
    this.db
      .prepare('UPDATE pending_changes SET attempts_left = ? WHERE id = ?')
      .run(attemptsLeft, id);
  }

  resolvePending(id: number, status: Exclude<PendingStatus, 'pending'>, now: number): void {
    this.db
      .prepare(
        "UPDATE pending_changes SET status = ?, resolved_at = ?, challenge = NULL WHERE id = ? AND status = 'pending'",
      )
      .run(status, now, id);
  }

  // ---- passes ----

  addPass(p: {
    kind: 'domain' | 'group';
    target: string;
    dayKey: string;
    startsAt: number;
    endsAt: number;
    uid: number | null;
  }): number {
    const res = this.db
      .prepare(
        'INSERT INTO passes (kind, target, day_key, starts_at, ends_at, requested_by_uid) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(p.kind, p.target, p.dayKey, p.startsAt, p.endsAt, p.uid);
    return Number(res.lastInsertRowid);
  }

  /** Passes in force at `now`. */
  activePasses(now: number): PassRow[] {
    const rows = this.db
      .prepare('SELECT * FROM passes WHERE ended_at IS NULL AND starts_at <= ? AND ends_at > ?')
      .all(now, now) as unknown as PassDbRow[];
    return rows.map(toPass);
  }

  passesOnDay(dayKey: string): PassRow[] {
    const rows = this.db
      .prepare('SELECT * FROM passes WHERE day_key = ? ORDER BY id')
      .all(dayKey) as unknown as PassDbRow[];
    return rows.map(toPass);
  }

  endPass(id: number, now: number): void {
    this.db
      .prepare('UPDATE passes SET ended_at = ? WHERE id = ? AND ended_at IS NULL')
      .run(now, id);
  }

  // ---- events ----

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
      .all(type) as unknown as { ts: number; uid: number | null; payload: string }[];
    return rows.map((r) => ({
      ts: Number(r.ts),
      uid: r.uid,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }
}
