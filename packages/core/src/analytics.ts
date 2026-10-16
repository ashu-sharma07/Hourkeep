import { localTime } from './schedule.js';

// Pure helpers for the numbers `hourkeep stats` shows. The daemon does the SQL; this is the
// arithmetic that decides what counts, so it can be tested without a database.

/** 15 minutes in milliseconds. Counters are stored per slot so any timezone offset (even :45) lines up. */
export const SLOT_MS = 15 * 60_000;

/** Start of the 15 minute slot containing `ts`. */
export function slotStart(ts: number): number {
  return Math.floor(ts / SLOT_MS) * SLOT_MS;
}

/**
 * Add whole days to a `YYYY-MM-DD` date key. Calendar arithmetic on the key itself, so it
 * does not depend on any timezone or daylight saving.
 */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** Every date key from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 4000) break; // a corrupt range must not run away
  }
  return out;
}

export type StatsRange = 'today' | 'week' | 'month' | 'all';
export const STATS_RANGES: readonly StatsRange[] = ['today', 'week', 'month', 'all'];

/** First date key of a range ending at `today`, or null for "since the beginning". */
export function rangeStart(range: StatsRange, today: string): string | null {
  switch (range) {
    case 'today':
      return today;
    case 'week':
      return addDays(today, -6);
    case 'month':
      return addDays(today, -29);
    case 'all':
      return null;
  }
}

/** Local hour of day (0-23) of a slot start, in `tz`. */
export function localHour(slot: number, tz: string): number {
  return Math.floor(localTime(slot, tz).minute / 60);
}

/** Sum counts into 24 local hour-of-day buckets. */
export function hourOfDay(rows: readonly { slot: number; count: number }[], tz: string): number[] {
  const out = new Array<number>(24).fill(0);
  for (const r of rows) out[localHour(r.slot, tz)] = (out[localHour(r.slot, tz)] ?? 0) + r.count;
  return out;
}

/** Sum counts into local days. Returns date keys in ascending order. */
export function dailyTotals(
  rows: readonly { slot: number; count: number }[],
  tz: string,
): { day: string; count: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    const day = localTime(r.slot, tz).dateKey;
    by.set(day, (by.get(day) ?? 0) + r.count);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));
}

/** What happened on one local day, as far as the streak is concerned. */
export interface DayFacts {
  readonly day: string;
  /** The daemon was running at some point that day with at least one rule. */
  readonly protectedDay: boolean;
  readonly tamper: number;
  readonly clockJumps: number;
  /** Protection-loosening changes applied that day (passes are the allowed path and do not count). */
  readonly loosened: number;
}

export function isCleanDay(f: DayFacts): boolean {
  return f.protectedDay && f.tamper === 0 && f.clockJumps === 0 && f.loosened === 0;
}

export interface Streak {
  /** Clean days in a row ending today. */
  readonly current: number;
  readonly longest: number;
  readonly cleanDays: number;
  /** Days from the first with data up to today. */
  readonly totalDays: number;
}

/**
 * Streak of clean days. `facts` may skip days (nothing recorded); a skipped day is not
 * clean, because nothing was protecting it.
 */
export function computeStreak(facts: readonly DayFacts[], today: string): Streak {
  const byDay = new Map(facts.map((f) => [f.day, f] as const));
  const first = facts.map((f) => f.day).sort()[0];
  if (first === undefined || first > today)
    return { current: 0, longest: 0, cleanDays: 0, totalDays: 0 };
  let longest = 0;
  let run = 0;
  let clean = 0;
  const days = daysBetween(first, today);
  for (const day of days) {
    const f = byDay.get(day);
    if (f && isCleanDay(f)) {
      run++;
      clean++;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { current: run, longest, cleanDays: clean, totalDays: days.length };
}

/** Share of issued challenges that were solved, as a whole percent, or null when none were issued. */
export function solveRate(solved: number, issued: number): number | null {
  return issued === 0 ? null : Math.round((solved / issued) * 100);
}

/** Add `ms` of dwell time for one check interval, ignoring gaps (daemon down, suspend). */
export function creditedMs(elapsedMs: number, intervalMs: number): number {
  if (elapsedMs <= 0) return 0;
  return elapsedMs <= intervalMs * 2 ? elapsedMs : 0;
}
