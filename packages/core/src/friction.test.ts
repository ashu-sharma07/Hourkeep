import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_WINDOW_MS,
  DEFAULT_SETTINGS,
  compareLimit,
  compareSettings,
  decidePass,
  parseSetting,
  passElapsedMs,
  phaseOf,
  planTimes,
  type PassLike,
  type Settings,
} from './friction.js';

const MIN = 60_000;
const settings: Settings = { ...DEFAULT_SETTINGS, timezone: 'UTC' };

describe('pending lifecycle', () => {
  const t = planTimes(1000, 10 * MIN);

  it('plans cooldown end and a 30 minute confirmation window after it', () => {
    expect(t).toEqual({
      requestedAt: 1000,
      cooldownEndsAt: 1000 + 10 * MIN,
      expiresAt: 1000 + 10 * MIN + CHALLENGE_WINDOW_MS,
    });
  });

  it('moves cooldown, ready, expired at exact boundaries', () => {
    expect(phaseOf(t, 1000)).toBe('cooldown');
    expect(phaseOf(t, t.cooldownEndsAt - 1)).toBe('cooldown');
    expect(phaseOf(t, t.cooldownEndsAt)).toBe('ready');
    expect(phaseOf(t, t.expiresAt - 1)).toBe('ready');
    expect(phaseOf(t, t.expiresAt)).toBe('expired');
  });

  it('a pass (cooldown 0) is ready immediately', () => {
    expect(phaseOf(planTimes(5, 0), 5)).toBe('ready');
  });
});

describe('compareLimit', () => {
  it.each([
    [null, null, 'same'],
    [30, 30, 'same'],
    [30, 20, 'tighten'],
    [30, 31, 'loosen'],
    [30, null, 'loosen'],
    [null, 30, 'tighten'],
    [0, 1, 'loosen'],
    [5, 0, 'tighten'],
  ] as const)('%s -> %s is %s', (from, to, expected) => {
    expect(compareLimit(from, to)).toBe(expected);
  });
});

describe('settings', () => {
  it('defaults match the owner-approved values', () => {
    expect(DEFAULT_SETTINGS).toEqual({ cooldownSeconds: 600, passesPerDay: 3, passMinutes: 15 });
  });

  it('parses values with units', () => {
    expect(parseSetting('cooldown', '30')).toEqual({ ok: true, value: { cooldownSeconds: 1800 } });
    expect(parseSetting('passes-per-day', '0')).toEqual({ ok: true, value: { passesPerDay: 0 } });
    expect(parseSetting('pass-minutes', '20')).toEqual({ ok: true, value: { passMinutes: 20 } });
    expect(parseSetting('timezone', ' Asia/Kolkata ')).toEqual({
      ok: true,
      value: { timezone: 'Asia/Kolkata' },
    });
  });

  it.each([
    ['cooldown', '0'],
    ['cooldown', '721'],
    ['cooldown', '-5'],
    ['cooldown', '1.5'],
    ['cooldown', 'ten'],
    ['passes-per-day', '25'],
    ['pass-minutes', '0'],
    ['pass-minutes', '181'],
    ['timezone', 'Mars/Base'],
    ['colour', 'red'],
  ])('rejects %s=%s', (k, v) => {
    expect(parseSetting(k, v).ok).toBe(false);
  });

  it('classifies each setting by direction', () => {
    expect(compareSettings(settings, { cooldownSeconds: 1800 })).toBe('tighten');
    expect(compareSettings(settings, { cooldownSeconds: 60 })).toBe('loosen');
    expect(compareSettings(settings, { passesPerDay: 2 })).toBe('tighten');
    expect(compareSettings(settings, { passesPerDay: 4 })).toBe('loosen');
    expect(compareSettings(settings, { passMinutes: 10 })).toBe('tighten');
    expect(compareSettings(settings, { passMinutes: 30 })).toBe('loosen');
    expect(compareSettings(settings, { timezone: 'Asia/Tokyo' })).toBe('loosen');
  });

  it('is "same" when nothing changes', () => {
    expect(compareSettings(settings, {})).toBe('same');
    expect(compareSettings(settings, { cooldownSeconds: 600, timezone: 'UTC' })).toBe('same');
  });

  it('a mixed patch is loosening if any field loosens', () => {
    expect(compareSettings(settings, { cooldownSeconds: 1800, passesPerDay: 9 })).toBe('loosen');
  });
});

describe('decidePass', () => {
  const day = '2026-10-14';
  const now = Date.parse('2026-10-14T10:00:00Z');
  const pass = (over: Partial<PassLike> = {}): PassLike => ({
    ruleKey: 'group:youtube',
    dayKey: day,
    startsAt: now - 60 * MIN,
    endsAt: now - 45 * MIN,
    endedAt: null,
    ...over,
  });
  const ask = (passes: PassLike[], limit: number | null = null, s: Settings = settings) =>
    decidePass({
      passes,
      ruleKey: 'group:youtube',
      dayKey: day,
      now,
      settings: s,
      ruleLimitMinutes: limit,
    });

  it('grants the default 15 minutes when nothing has been used', () => {
    expect(ask([])).toEqual({ ok: true, grant: { durationMs: 15 * MIN } });
  });

  it('allows exactly passes-per-day passes, counted across all rules', () => {
    const three = [pass(), pass({ ruleKey: 'domain:x.com' }), pass()];
    expect(ask(three.slice(0, 2)).ok).toBe(true);
    const r = ask(three);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('all 3 passes');
  });

  it('ignores passes from other days', () => {
    expect(
      ask([
        pass({ dayKey: '2026-10-13' }),
        pass({ dayKey: '2026-10-13' }),
        pass({ dayKey: '2026-10-13' }),
      ]).ok,
    ).toBe(true);
  });

  it('an early-ended pass still counts toward the daily count', () => {
    const ended = pass({ endedAt: now - 59 * MIN });
    expect(ask([ended, ended, ended]).ok).toBe(false);
  });

  it('turns passes off with passes-per-day 0', () => {
    const r = ask([], null, { ...settings, passesPerDay: 0 });
    expect(!r.ok && r.reason).toContain('turned off');
  });

  describe('per-rule daily limit', () => {
    it('trims the grant to the minutes left, using actual minutes used', () => {
      // 15 minutes used, limit 20 -> 5 left
      expect(ask([pass()], 20)).toEqual({ ok: true, grant: { durationMs: 5 * MIN } });
      // an early-ended pass only used 3 minutes
      const early = pass({ endedAt: now - 57 * MIN });
      expect(ask([early], 20)).toEqual({ ok: true, grant: { durationMs: 15 * MIN } });
    });

    it('refuses when under a minute is left or the limit is used', () => {
      expect(ask([pass()], 15).ok).toBe(false);
      expect(ask([pass()], 15)).toMatchObject({ reason: expect.stringContaining('used up') });
    });

    it('limit 0 means no passes for this rule', () => {
      const r = ask([], 0);
      expect(!r.ok && r.reason).toContain('no passes');
    });

    it('only counts minutes of the same rule', () => {
      const other = pass({ ruleKey: 'domain:x.com' });
      expect(ask([other], 15)).toEqual({ ok: true, grant: { durationMs: 15 * MIN } });
    });

    it('counts a running pass for the time elapsed so far', () => {
      const running = pass({ startsAt: now - 5 * MIN, endsAt: now + 10 * MIN });
      expect(ask([running], 20)).toEqual({ ok: true, grant: { durationMs: 15 * MIN } });
      expect(ask([running], 12)).toEqual({ ok: true, grant: { durationMs: 7 * MIN } });
    });

    it('a null limit never trims', () => {
      expect(ask([pass()], null)).toEqual({ ok: true, grant: { durationMs: 15 * MIN } });
    });
  });

  it('respects a custom pass length', () => {
    expect(ask([], null, { ...settings, passMinutes: 5 })).toEqual({
      ok: true,
      grant: { durationMs: 5 * MIN },
    });
  });
});

describe('passElapsedMs', () => {
  const p: PassLike = {
    ruleKey: 'k',
    dayKey: 'd',
    startsAt: 1000,
    endsAt: 1000 + 15 * MIN,
    endedAt: null,
  };
  it('counts up to now, then stops at the end or early end', () => {
    expect(passElapsedMs(p, 500)).toBe(0);
    expect(passElapsedMs(p, 1000 + 5 * MIN)).toBe(5 * MIN);
    expect(passElapsedMs(p, 1000 + 99 * MIN)).toBe(15 * MIN);
    expect(passElapsedMs({ ...p, endedAt: 1000 + 2 * MIN }, 1000 + 99 * MIN)).toBe(2 * MIN);
  });
});
