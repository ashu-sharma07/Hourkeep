import {
  computeStreak,
  dailyTotals,
  dateKey,
  hourOfDay,
  localTime,
  rangeStart,
  solveRate,
  type DayFacts,
  type StatsRange,
} from '@hourkeep/core';
import type { StatsData } from '@hourkeep/ipc';
import type { EventType, Store } from './store.js';

// Aggregation for `hourkeep stats`. Everything is read from counters and the event log the
// daemon already keeps; nothing here records anything new. All days are local days in the
// timezone setting.

const FRICTION_EVENTS: EventType[] = [
  'change_requested',
  'change_applied',
  'change_cancelled',
  'change_expired',
  'challenge_issued',
  'challenge_failed',
  'pass_started',
];
const STREAK_EVENTS: EventType[] = ['tamper', 'clock_jump', 'change_applied'];

/** UTC midnight of a date key minus the widest timezone offset: no local day starts earlier. */
const earliestInstant = (key: string): number => Date.parse(`${key}T00:00:00Z`) - 14 * 3600_000;

const CHANGE_KINDS = [
  'remove_rule',
  'set_schedule',
  'set_limit',
  'set_setting',
  'start_pass',
] as const;
const CHALLENGE_KINDS = ['typing', 'arithmetic', 'reflection', 'unknown'] as const;
type ChallengeLabel = (typeof CHALLENGE_KINDS)[number];

const label = (v: unknown): ChallengeLabel =>
  typeof v === 'string' && (CHALLENGE_KINDS as readonly string[]).includes(v)
    ? (v as ChallengeLabel)
    : 'unknown';

const inRange = (day: string, from: string | null): boolean => from === null || day >= from;
const seconds = (ms: number): number => Math.round(ms / 1000);

export function computeStats(
  store: Store,
  range: StatsRange,
  now: number,
  tz: string,
  dnsEnabled: boolean,
): StatsData {
  const today = dateKey(now, tz);
  const from = rangeStart(range, today);
  const sinceTs = from === null ? 0 : earliestInstant(from);
  const dayOf = (ts: number): string => localTime(ts, tz).dateKey;

  // ---- DNS ----
  const blockedRows = store.dnsBlockedSince(sinceTs).filter((r) => inRange(dayOf(r.slot), from));
  const byRule = new Map<string, { kind: 'domain' | 'group'; target: string; blocked: number }>();
  const bySuffix = new Map<string, number>();
  const perSlot = new Map<number, number>();
  let blocked = 0;
  for (const r of blockedRows) {
    blocked += r.count;
    const k = `${r.kind}:${r.target}`;
    const cur = byRule.get(k) ?? { kind: r.kind, target: r.target, blocked: 0 };
    cur.blocked += r.count;
    byRule.set(k, cur);
    bySuffix.set(r.suffix, (bySuffix.get(r.suffix) ?? 0) + r.count);
    perSlot.set(r.slot, (perSlot.get(r.slot) ?? 0) + r.count);
  }
  const slotRows = [...perSlot.entries()].map(([slot, count]) => ({ slot, count }));
  const forwarded = store
    .dnsTotalsSince(sinceTs)
    .filter((r) => inRange(dayOf(r.slot), from))
    .reduce((n, r) => n + r.forwarded, 0);
  const desc = <T extends { blocked: number }>(a: T, b: T): number => b.blocked - a.blocked;

  // ---- time in each state ----
  const stateRows = store.stateTimeSince(from).filter((r) => inRange(r.day, from));
  const timeByRule = new Map<
    string,
    { kind: 'domain' | 'group'; target: string; blocking: number; pass: number; off: number }
  >();
  for (const r of stateRows) {
    const k = `${r.kind}:${r.target}`;
    const cur = timeByRule.get(k) ?? {
      kind: r.kind,
      target: r.target,
      blocking: 0,
      pass: 0,
      off: 0,
    };
    if (r.state === 'blocking') cur.blocking += r.ms;
    else if (r.state === 'pass') cur.pass += r.ms;
    else cur.off += r.ms;
    timeByRule.set(k, cur);
  }
  const activity = store.activitySince(from);
  const cooldownMs = activity
    .filter((a) => a.key === 'cooldown' && inRange(a.day, from))
    .reduce((n, a) => n + a.ms, 0);

  // ---- friction ----
  const events = store
    .eventRows(FRICTION_EVENTS, sinceTs)
    .filter((e) => inRange(dayOf(e.ts), from));
  const count = (type: EventType): number => events.filter((e) => e.type === type).length;
  const byChange = CHANGE_KINDS.map((kind) => ({
    kind,
    requested: events.filter((e) => e.type === 'change_requested' && e.payload['kind'] === kind)
      .length,
    applied: events.filter((e) => e.type === 'change_applied' && e.payload['kind'] === kind).length,
  })).filter((c) => c.requested > 0 || c.applied > 0);
  const challenges = CHALLENGE_KINDS.map((kind) => {
    const issued = events.filter(
      (e) => e.type === 'challenge_issued' && label(e.payload['kind']) === kind,
    ).length;
    const solved = events.filter(
      (e) => e.type === 'change_applied' && label(e.payload['challengeKind']) === kind,
    ).length;
    const wrongAnswers = events.filter(
      (e) => e.type === 'challenge_failed' && label(e.payload['kind']) === kind,
    ).length;
    return { kind, issued, solved, wrongAnswers, solveRate: solveRate(solved, issued) };
  }).filter((c) => c.issued > 0 || c.solved > 0 || c.wrongAnswers > 0);

  // ---- tamper ----
  const tamperEvents = store
    .eventRows(['tamper', 'clock_jump'], sinceTs)
    .filter((e) => inRange(dayOf(e.ts), from));
  const tamperByDay = new Map<string, number>();
  for (const e of tamperEvents.filter((x) => x.type === 'tamper'))
    tamperByDay.set(dayOf(e.ts), (tamperByDay.get(dayOf(e.ts)) ?? 0) + 1);

  // ---- streak (all history, whatever the range) ----
  const facts = new Map<
    string,
    { protectedDay: boolean; tamper: number; clockJumps: number; loosened: number }
  >();
  const fact = (day: string) => {
    let f = facts.get(day);
    if (!f) facts.set(day, (f = { protectedDay: false, tamper: 0, clockJumps: 0, loosened: 0 }));
    return f;
  };
  for (const a of store.activitySince(null))
    if (a.key === 'protected' && a.ms > 0) fact(a.day).protectedDay = true;
  for (const e of store.eventRows(STREAK_EVENTS, 0)) {
    const f = fact(dayOf(e.ts));
    if (e.type === 'tamper') f.tamper++;
    else if (e.type === 'clock_jump') f.clockJumps++;
    else if (e.payload['kind'] !== 'start_pass') f.loosened++; // a pass is the allowed path
  }
  const dayFacts: DayFacts[] = [...facts.entries()].map(([day, f]) => ({ day, ...f }));

  return {
    range,
    from: from ?? (dayFacts.length ? (dayFacts.map((d) => d.day).sort()[0] ?? null) : null),
    to: today,
    timezone: tz,
    generatedAt: now,
    dns: {
      enabled: dnsEnabled,
      blocked,
      forwarded,
      byRule: [...byRule.values()].sort(desc).slice(0, 200),
      bySuffix: [...bySuffix.entries()]
        .map(([suffix, n]) => ({ suffix, blocked: n }))
        .sort(desc)
        .slice(0, 50),
      hourOfDay: hourOfDay(slotRows, tz),
      daily: dailyTotals(slotRows, tz)
        .map((d) => ({ day: d.day, blocked: d.count }))
        .slice(-400),
    },
    time: {
      rules: [...timeByRule.values()]
        .map((r) => ({
          kind: r.kind,
          target: r.target,
          blockingSeconds: seconds(r.blocking),
          passSeconds: seconds(r.pass),
          scheduledOffSeconds: seconds(r.off),
        }))
        .slice(0, 200),
      cooldownSeconds: seconds(cooldownMs),
    },
    friction: {
      requested: count('change_requested'),
      applied: count('change_applied'),
      cancelled: count('change_cancelled'),
      expired: count('change_expired'),
      passesStarted: count('pass_started'),
      byChange,
      challenges,
    },
    streak: computeStreak(dayFacts, today),
    tamper: {
      count: tamperEvents.filter((e) => e.type === 'tamper').length,
      clockJumps: tamperEvents.filter((e) => e.type === 'clock_jump').length,
      byDay: [...tamperByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, n]) => ({ day, count: n }))
        .slice(-400),
    },
  };
}

/** Blocked lookups so far on the current local day. */
export function blockedToday(store: Store, now: number, tz: string): number {
  const today = dateKey(now, tz);
  return store
    .dnsBlockedSince(earliestInstant(today))
    .filter((r) => localTime(r.slot, tz).dateKey === today)
    .reduce((n, r) => n + r.count, 0);
}
