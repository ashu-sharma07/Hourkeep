import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  isActive,
  isAlwaysOn,
  isValidTimezone,
  localTime,
  loosensSchedule,
  makeSchedule,
  normalizeWindows,
  parseScheduleSpec,
  scheduleEquals,
  dateKey,
  type WeeklySchedule,
} from './schedule.js';

const sched = (specs: string[], tz = 'UTC'): WeeklySchedule => {
  const r = parseScheduleSpec(specs, tz);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const utc = (iso: string): number => Date.parse(iso);

describe('parseScheduleSpec', () => {
  it('reads day ranges, lists and aliases', () => {
    const s = sched(['mon-fri 09:00-17:00', 'sat,sun 10:00-12:00']);
    expect(s.days.mon).toEqual([{ start: 540, end: 1020 }]);
    expect(s.days.fri).toEqual([{ start: 540, end: 1020 }]);
    expect(s.days.sat).toEqual([{ start: 600, end: 720 }]);
    expect(sched(['weekends 08:00-09:00']).days.sun).toEqual([{ start: 480, end: 540 }]);
    expect(sched(['daily 00:00-24:00']).days.wed).toEqual([{ start: 0, end: 1440 }]);
    expect(sched(['Monday 9:00-10:00']).days.mon).toEqual([{ start: 540, end: 600 }]);
  });

  it('wraps day ranges over the weekend', () => {
    const s = sched(['fri-mon 20:00-21:00']);
    expect(
      Object.entries(s.days)
        .filter(([, w]) => w.length)
        .map(([d]) => d),
    ).toEqual(['mon', 'fri', 'sat', 'sun']);
  });

  it('splits overnight windows across midnight', () => {
    const s = sched(['fri 22:00-02:00']);
    expect(s.days.fri).toEqual([{ start: 1320, end: 1440 }]);
    expect(s.days.sat).toEqual([{ start: 0, end: 120 }]);
  });

  it('wraps an overnight window from sunday to monday', () => {
    const s = sched(['sun 23:00-01:00']);
    expect(s.days.sun).toEqual([{ start: 1380, end: 1440 }]);
    expect(s.days.mon).toEqual([{ start: 0, end: 60 }]);
  });

  it('treats an end of 00:00 as midnight', () => {
    expect(sched(['mon 22:00-00:00']).days.mon).toEqual([{ start: 1320, end: 1440 }]);
  });

  it('merges overlapping and touching windows', () => {
    const s = sched(['mon 09:00-12:00', 'mon 11:00-13:00', 'mon 13:00-14:00']);
    expect(s.days.mon).toEqual([{ start: 540, end: 840 }]);
  });

  it.each([
    [[]],
    [['mon']],
    [['mon 09:00']],
    [['someday 09:00-10:00']],
    [['mon 25:00-26:00']],
    [['mon 09:60-10:00']],
    [['mon 09:00-09:00']],
    [['mon 24:00-25:00']],
    [['mon-xyz 09:00-10:00']],
    [['mon 9-10']],
  ])('rejects %j', (specs) => {
    expect(parseScheduleSpec(specs, 'UTC').ok).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    const r = parseScheduleSpec(['mon 09:00-10:00'], 'Mars/Olympus');
    expect(r.ok).toBe(false);
  });
});

describe('normalizeWindows / makeSchedule', () => {
  it('rejects out-of-range and inverted windows', () => {
    expect(normalizeWindows([{ start: 10, end: 10 }]).ok).toBe(false);
    expect(normalizeWindows([{ start: -1, end: 10 }]).ok).toBe(false);
    expect(normalizeWindows([{ start: 0, end: 1441 }]).ok).toBe(false);
    expect(normalizeWindows([{ start: 1.5, end: 10 }]).ok).toBe(false);
  });

  it('caps windows per day', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ start: i * 50, end: i * 50 + 10 }));
    expect(normalizeWindows(many).ok).toBe(false);
  });

  it('fills unlisted days with nothing', () => {
    const r = makeSchedule('UTC', { mon: [{ start: 0, end: 60 }] });
    expect(r.ok && r.value.days.tue).toEqual([]);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Nowhere/Land')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('localTime / dateKey', () => {
  it('converts to the wall clock of the timezone', () => {
    // 2026-10-14 is a Wednesday
    expect(localTime(utc('2026-10-14T08:00:00Z'), 'Asia/Kolkata')).toEqual({
      day: 'wed',
      minute: 810,
      dateKey: '2026-10-14',
    });
    expect(localTime(utc('2026-10-14T23:30:00Z'), 'Asia/Kolkata')).toMatchObject({
      day: 'thu',
      minute: 300,
      dateKey: '2026-10-15',
    });
  });

  it('reads midnight as hour 0, not 24', () => {
    expect(localTime(utc('2026-10-14T00:00:00Z'), 'UTC').minute).toBe(0);
    expect(dateKey(utc('2026-10-14T00:00:00Z'), 'UTC')).toBe('2026-10-14');
  });
});

describe('isActive', () => {
  it('is always true without a schedule', () => {
    expect(isActive(null, 0)).toBe(true);
  });

  it('follows weekday windows with exclusive ends', () => {
    const s = sched(['mon-fri 09:00-17:00']);
    expect(isActive(s, utc('2026-10-14T08:59:59Z'))).toBe(false);
    expect(isActive(s, utc('2026-10-14T09:00:00Z'))).toBe(true);
    expect(isActive(s, utc('2026-10-14T16:59:59Z'))).toBe(true);
    expect(isActive(s, utc('2026-10-14T17:00:00Z'))).toBe(false);
    expect(isActive(s, utc('2026-10-17T12:00:00Z'))).toBe(false); // Saturday
  });

  it('uses the schedule timezone, not the machine timezone', () => {
    const s = sched(['mon-fri 09:00-17:00'], 'Asia/Kolkata');
    expect(isActive(s, utc('2026-10-14T03:29:00Z'))).toBe(false); // 08:59 IST
    expect(isActive(s, utc('2026-10-14T03:30:00Z'))).toBe(true); // 09:00 IST
    expect(isActive(s, utc('2026-10-14T11:30:00Z'))).toBe(false); // 17:00 IST
  });

  it('handles an overnight window across the date change', () => {
    const s = sched(['fri 22:00-02:00']);
    expect(isActive(s, utc('2026-10-16T23:00:00Z'))).toBe(true); // Fri 23:00
    expect(isActive(s, utc('2026-10-17T01:59:00Z'))).toBe(true); // Sat 01:59
    expect(isActive(s, utc('2026-10-17T02:00:00Z'))).toBe(false);
    expect(isActive(s, utc('2026-10-16T21:59:00Z'))).toBe(false);
  });

  describe('daylight saving (America/New_York)', () => {
    it('spring forward 2026-03-08: wall-clock window spans the gap correctly', () => {
      const s = sched(['sun 01:30-03:30'], 'America/New_York');
      expect(isActive(s, utc('2026-03-08T06:29:59Z'))).toBe(false); // 01:29:59 EST
      expect(isActive(s, utc('2026-03-08T06:30:00Z'))).toBe(true); // 01:30 EST
      expect(isActive(s, utc('2026-03-08T06:59:59Z'))).toBe(true); // 01:59:59 EST
      expect(isActive(s, utc('2026-03-08T07:00:00Z'))).toBe(true); // 03:00 EDT (02:00 never happens)
      expect(isActive(s, utc('2026-03-08T07:29:59Z'))).toBe(true); // 03:29:59 EDT
      expect(isActive(s, utc('2026-03-08T07:30:00Z'))).toBe(false); // 03:30 EDT
    });

    it('fall back 2026-11-01: the repeated hour is active both times', () => {
      const s = sched(['sun 01:00-02:00'], 'America/New_York');
      expect(isActive(s, utc('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
      expect(isActive(s, utc('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST (second time)
      expect(isActive(s, utc('2026-11-01T07:00:00Z'))).toBe(false); // 02:00 EST
      expect(isActive(s, utc('2026-11-01T04:59:00Z'))).toBe(false); // 00:59 EDT
    });

    it('a 24 hour day is not assumed: the day key changes at local midnight', () => {
      expect(dateKey(utc('2026-03-08T04:59:00Z'), 'America/New_York')).toBe('2026-03-07');
      expect(dateKey(utc('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08');
      expect(dateKey(utc('2026-03-09T03:59:00Z'), 'America/New_York')).toBe('2026-03-08'); // 23h day
      expect(dateKey(utc('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
    });
  });
});

describe('loosensSchedule', () => {
  const work = sched(['mon-fri 09:00-17:00']);

  it('is false when nothing changes or coverage grows', () => {
    expect(loosensSchedule(work, work)).toBe(false);
    expect(loosensSchedule(work, sched(['mon-fri 08:00-18:00']))).toBe(false);
    expect(loosensSchedule(work, sched(['daily 00:00-24:00']))).toBe(false);
    expect(loosensSchedule(work, null)).toBe(false);
    expect(loosensSchedule(null, null)).toBe(false);
  });

  it('is true when any minute stops blocking', () => {
    expect(loosensSchedule(work, sched(['mon-fri 09:00-16:59']))).toBe(true);
    expect(loosensSchedule(work, sched(['mon-thu 09:00-17:00']))).toBe(true);
    expect(loosensSchedule(work, sched(['mon-fri 10:00-17:00']))).toBe(true);
  });

  it('treats a mixed change (some added, some removed) as loosening', () => {
    expect(loosensSchedule(work, sched(['mon-fri 10:00-18:00']))).toBe(true);
  });

  it('is true when going from always to a partial schedule, false to an equivalent full one', () => {
    expect(loosensSchedule(null, work)).toBe(true);
    expect(loosensSchedule(null, sched(['daily 00:00-24:00']))).toBe(false);
    expect(loosensSchedule(null, sched(['daily 00:00-23:59']))).toBe(true);
  });

  it('is true for an empty schedule (blocks never)', () => {
    const none = makeSchedule('UTC', {});
    expect(none.ok && loosensSchedule(work, none.value)).toBe(true);
  });

  it('counts a timezone change as loosening unless both are always-on', () => {
    expect(
      loosensSchedule(
        sched(['mon-fri 09:00-17:00'], 'UTC'),
        sched(['mon-fri 09:00-17:00'], 'Asia/Kolkata'),
      ),
    ).toBe(true);
    expect(
      loosensSchedule(
        sched(['daily 00:00-24:00'], 'UTC'),
        sched(['daily 00:00-24:00'], 'Asia/Kolkata'),
      ),
    ).toBe(false);
  });
});

describe('scheduleEquals / isAlwaysOn / describeSchedule', () => {
  it('compares by blocked minutes, not by how they were written', () => {
    expect(
      scheduleEquals(sched(['mon 09:00-12:00', 'mon 12:00-13:00']), sched(['mon 09:00-13:00'])),
    ).toBe(true);
    expect(scheduleEquals(sched(['mon 09:00-12:00']), sched(['mon 09:00-13:00']))).toBe(false);
    expect(scheduleEquals(null, sched(['daily 00:00-24:00']))).toBe(true);
    expect(scheduleEquals(null, sched(['mon 09:00-13:00']))).toBe(false);
  });

  it('knows when a schedule blocks around the clock', () => {
    expect(isAlwaysOn(null)).toBe(true);
    expect(isAlwaysOn(sched(['daily 00:00-24:00']))).toBe(true);
    expect(isAlwaysOn(sched(['mon-fri 00:00-24:00']))).toBe(false);
  });

  it('describes schedules compactly', () => {
    expect(describeSchedule(null)).toBe('always');
    expect(
      describeSchedule(sched(['mon-fri 09:00-17:00', 'sat 10:00-12:00'], 'Asia/Kolkata')),
    ).toBe('mon-fri 09:00-17:00; sat 10:00-12:00 (Asia/Kolkata)');
    expect(describeSchedule(sched(['mon,wed 09:00-10:00']))).toBe(
      'mon 09:00-10:00; wed 09:00-10:00 (UTC)',
    );
    const none = makeSchedule('UTC', {});
    expect(none.ok && describeSchedule(none.value)).toBe('never (UTC)');
  });
});
