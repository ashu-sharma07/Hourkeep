import { describe, expect, it } from 'vitest';
import {
  SLOT_MS,
  addDays,
  computeStreak,
  creditedMs,
  dailyTotals,
  daysBetween,
  hourOfDay,
  isCleanDay,
  localHour,
  rangeStart,
  slotStart,
  solveRate,
  type DayFacts,
} from './analytics.js';

const utc = (iso: string) => Date.parse(iso);
const day = (d: string, over: Partial<DayFacts> = {}): DayFacts => ({
  day: d,
  protectedDay: true,
  tamper: 0,
  clockJumps: 0,
  loosened: 0,
  ...over,
});

describe('slots', () => {
  it('floor to 15 minutes', () => {
    expect(slotStart(utc('2026-10-14T10:14:59Z'))).toBe(utc('2026-10-14T10:00:00Z'));
    expect(slotStart(utc('2026-10-14T10:15:00Z'))).toBe(utc('2026-10-14T10:15:00Z'));
    expect(SLOT_MS).toBe(900_000);
  });
});

describe('date keys', () => {
  it('add days across month, year and leap boundaries', () => {
    expect(addDays('2026-10-14', 1)).toBe('2026-10-15');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2026-10-14', -30)).toBe('2026-09-14');
  });

  it('list every day in a range, inclusive', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(daysBetween('2026-10-14', '2026-10-14')).toEqual(['2026-10-14']);
    expect(daysBetween('2026-10-15', '2026-10-14')).toEqual([]);
  });

  it('range starts', () => {
    expect(rangeStart('today', '2026-10-14')).toBe('2026-10-14');
    expect(rangeStart('week', '2026-10-14')).toBe('2026-10-08');
    expect(rangeStart('month', '2026-10-14')).toBe('2026-09-15');
    expect(rangeStart('all', '2026-10-14')).toBeNull();
  });
});

describe('hour buckets', () => {
  const rows = [
    { slot: utc('2026-10-14T10:00:00Z'), count: 3 },
    { slot: utc('2026-10-14T10:45:00Z'), count: 2 },
    { slot: utc('2026-10-14T22:30:00Z'), count: 5 },
  ];

  it('sum into local hours of day (UTC)', () => {
    const h = hourOfDay(rows, 'UTC');
    expect(h).toHaveLength(24);
    expect(h[10]).toBe(5);
    expect(h[22]).toBe(5);
    expect(h.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('shift into the local timezone, including half-hour offsets', () => {
    expect(localHour(utc('2026-10-14T10:00:00Z'), 'Asia/Kolkata')).toBe(15); // 15:30
    expect(localHour(utc('2026-10-14T10:30:00Z'), 'Asia/Kolkata')).toBe(16); // 16:00
    const h = hourOfDay(rows, 'Asia/Kolkata');
    expect(h[15]).toBe(3); // 10:00Z = 15:30
    expect(h[16]).toBe(2); // 10:45Z = 16:15
    expect(h[4]).toBe(5); // 22:30Z = 04:00 next day
  });

  it('daily totals use local days and come out sorted', () => {
    expect(dailyTotals(rows, 'UTC')).toEqual([{ day: '2026-10-14', count: 10 }]);
    expect(dailyTotals(rows, 'Asia/Kolkata')).toEqual([
      { day: '2026-10-14', count: 5 },
      { day: '2026-10-15', count: 5 },
    ]);
    expect(dailyTotals([], 'UTC')).toEqual([]);
  });
});

describe('streaks', () => {
  const today = '2026-10-14';

  it('counts consecutive clean days ending today', () => {
    const s = computeStreak([day('2026-10-12'), day('2026-10-13'), day('2026-10-14')], today);
    expect(s).toEqual({ current: 3, longest: 3, cleanDays: 3, totalDays: 3 });
  });

  it('a tamper event breaks the streak and restarts it after', () => {
    const facts = [
      day('2026-10-10'),
      day('2026-10-11'),
      day('2026-10-12', { tamper: 1 }),
      day('2026-10-13'),
      day('2026-10-14'),
    ];
    expect(computeStreak(facts, today)).toEqual({
      current: 2,
      longest: 2,
      cleanDays: 4,
      totalDays: 5,
    });
  });

  it('a tamper today means no current streak', () => {
    const facts = [day('2026-10-13'), day('2026-10-14', { tamper: 2 })];
    expect(computeStreak(facts, today)).toMatchObject({ current: 0, longest: 1 });
  });

  it('a loosening change or a clock jump breaks a day; a pass does not (it is not a fact here)', () => {
    expect(isCleanDay(day('d', { loosened: 1 }))).toBe(false);
    expect(isCleanDay(day('d', { clockJumps: 1 }))).toBe(false);
    expect(isCleanDay(day('d'))).toBe(true);
  });

  it('a day with no protection, or no record at all, is not clean', () => {
    const facts = [
      day('2026-10-11'),
      day('2026-10-12', { protectedDay: false }),
      day('2026-10-14'),
    ];
    // 13th has no record
    expect(computeStreak(facts, today)).toEqual({
      current: 1,
      longest: 1,
      cleanDays: 2,
      totalDays: 4,
    });
  });

  it('the longest run can lie in the past', () => {
    const facts = ['01', '02', '03', '04']
      .map((d) => day(`2026-10-${d}`))
      .concat([day('2026-10-14')]);
    expect(computeStreak(facts, today)).toMatchObject({ current: 1, longest: 4 });
  });

  it('handles empty input and data from the future', () => {
    expect(computeStreak([], today)).toEqual({
      current: 0,
      longest: 0,
      cleanDays: 0,
      totalDays: 0,
    });
    expect(computeStreak([day('2026-10-20')], today).totalDays).toBe(0);
  });
});

describe('rates and dwell time', () => {
  it('solve rate is a whole percent, or null with nothing issued', () => {
    expect(solveRate(1, 3)).toBe(33);
    expect(solveRate(2, 3)).toBe(67);
    expect(solveRate(0, 4)).toBe(0);
    expect(solveRate(4, 4)).toBe(100);
    expect(solveRate(0, 0)).toBeNull();
  });

  it('credits normal intervals and ignores gaps', () => {
    expect(creditedMs(5000, 5000)).toBe(5000);
    expect(creditedMs(9999, 5000)).toBe(9999);
    expect(creditedMs(10_001, 5000)).toBe(0); // daemon was down or the machine slept
    expect(creditedMs(0, 5000)).toBe(0);
    expect(creditedMs(-5, 5000)).toBe(0);
  });
});
