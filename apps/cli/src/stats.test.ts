import { describe, expect, it } from 'vitest';
import type { StatsData } from '@hourkeep/ipc';
import { runCli, type CliIo } from './cli.js';
import { bar, dur, formatStats, hourChart } from './format.js';

const stats: StatsData = {
  range: 'week',
  from: '2026-10-10',
  to: '2026-10-16',
  timezone: 'Asia/Kolkata',
  generatedAt: 1,
  dns: {
    enabled: true,
    blocked: 1412,
    forwarded: 15230,
    byRule: [
      { kind: 'group', target: 'youtube', blocked: 1390 },
      { kind: 'domain', target: 'reddit.com', blocked: 22 },
    ],
    bySuffix: [
      { suffix: 'googlevideo.com', blocked: 1001 },
      { suffix: 'youtube.com', blocked: 389 },
      { suffix: 'reddit.com', blocked: 22 },
    ],
    hourOfDay: [
      0, 0, 0, 0, 0, 0, 0, 0, 12, 40, 80, 100, 30, 0, 0, 200, 400, 300, 150, 60, 20, 10, 5, 5,
    ],
    daily: [
      { day: '2026-10-14', blocked: 400 },
      { day: '2026-10-15', blocked: 12 },
      { day: '2026-10-16', blocked: 1000 },
    ],
  },
  time: {
    rules: [
      {
        kind: 'group',
        target: 'youtube',
        blockingSeconds: 3 * 86400 + 3600,
        passSeconds: 720,
        scheduledOffSeconds: 90_000,
      },
    ],
    cooldownSeconds: 245,
  },
  friction: {
    requested: 5,
    applied: 2,
    cancelled: 2,
    expired: 1,
    passesStarted: 3,
    byChange: [
      { kind: 'remove_rule', requested: 3, applied: 1 },
      { kind: 'start_pass', requested: 3, applied: 3 },
    ],
    challenges: [
      { kind: 'typing', issued: 4, solved: 2, wrongAnswers: 5, solveRate: 50 },
      { kind: 'reflection', issued: 1, solved: 0, wrongAnswers: 0, solveRate: 0 },
    ],
  },
  streak: { current: 3, longest: 7, cleanDays: 12, totalDays: 14 },
  tamper: { count: 2, clockJumps: 1, byDay: [{ day: '2026-10-12', count: 2 }] },
};

describe('formatStats', () => {
  const t = formatStats(stats);

  it('names the period and timezone', () => {
    expect(t.split('\n')[0]).toBe(
      'Hourkeep stats: last 7 days (2026-10-10 to 2026-10-16), times in Asia/Kolkata',
    );
  });

  it('shows blocked and forwarded counts with separators, and explains what a lookup is', () => {
    expect(t).toContain('1,412 blocked, 15,230 allowed and forwarded (names are never recorded)');
    expect(t).toContain('counts lookups, not visits');
  });

  it('lists rules and the most blocked domains with counts', () => {
    expect(t).toMatch(/youtube \(group\)\s+1,390\s+█+/);
    expect(t).toMatch(/reddit.com \(domain\)\s+22\s+█/);
    expect(t).toMatch(/googlevideo.com\s+1,001/);
  });

  it('draws the hours and days', () => {
    expect(t).toContain('By hour of day (local time)');
    expect(t).toContain('By day');
    expect(t).toMatch(/2026-10-16\s+1,000\s+█+/);
  });

  it('reports time per state in plain units', () => {
    expect(t).toContain('blocking 3d 1h, on a pass 12m, outside its schedule 1d 1h');
    expect(t).toContain('Waiting out a cooldown: 4m');
  });

  it('reports friction with challenge solve rates', () => {
    expect(t).toContain(
      'Changes asked for: 5. Applied: 2, cancelled: 2, expired unanswered: 1. Passes started: 3.',
    );
    expect(t).toContain('typing      issued 4, solved 2, wrong answers 5, solve rate 50%');
    expect(t).toContain('reflection  issued 1, solved 0, wrong answers 0, solve rate 0%');
  });

  it('explains the streak and tamper', () => {
    expect(t).toContain('3 clean days in a row, longest 7. Clean days: 12 of 14.');
    expect(t).toContain('Passes do not count against you.');
    expect(t).toContain('2 events (2026-10-12: 2). System clock changes: 1.');
  });

  it('copes with an empty period and with the DNS layer off', () => {
    const empty = formatStats({
      ...stats,
      range: 'today',
      dns: {
        enabled: false,
        blocked: 0,
        forwarded: 0,
        byRule: [],
        bySuffix: [],
        hourOfDay: new Array(24).fill(0),
        daily: [],
      },
      time: { rules: [], cooldownSeconds: 0 },
      friction: {
        requested: 0,
        applied: 0,
        cancelled: 0,
        expired: 0,
        passesStarted: 0,
        byChange: [],
        challenges: [],
      },
      streak: { current: 0, longest: 0, cleanDays: 0, totalDays: 0 },
      tamper: { count: 0, clockJumps: 0, byDay: [] },
    });
    expect(empty).toContain('today (2026-10-16)');
    expect(empty).toContain('The DNS layer is off, so lookups are not counted.');
    expect(empty).toContain('Nothing recorded yet.');
    expect(empty).toContain('No protected days yet.');
    expect(empty).toContain('Tamper\n  None.');
    expect(empty).not.toContain('By hour of day');
  });

  it('uses singular words for one event and one day', () => {
    const one = formatStats({
      ...stats,
      streak: { current: 1, longest: 1, cleanDays: 1, totalDays: 1 },
      tamper: { count: 1, clockJumps: 0, byDay: [{ day: '2026-10-12', count: 1 }] },
    });
    expect(one).toContain('1 clean day in a row');
    expect(one).toContain('1 event (2026-10-12: 1)');
  });

  it('labels every range', () => {
    expect(formatStats({ ...stats, range: 'month' })).toContain(
      'last 30 days (2026-10-10 to 2026-10-16)',
    );
    expect(formatStats({ ...stats, range: 'all' })).toContain('everything since 2026-10-10');
    expect(formatStats({ ...stats, range: 'all', from: null })).toContain('everything so far');
  });
});

describe('chart helpers', () => {
  it('bars scale to the maximum and always show a non-zero value', () => {
    expect(bar(100, 100, 10)).toBe('█'.repeat(10));
    expect(bar(50, 100, 10)).toBe('█'.repeat(5));
    expect(bar(1, 1000, 10)).toBe('█');
    expect(bar(0, 100)).toBe('');
    expect(bar(5, 0)).toBe('');
  });

  it('the hour sparkline has 24 cells, a dot for quiet hours, and a ruler', () => {
    const [line, tens, ones] = hourChart(stats.dns.hourOfDay);
    expect([...(line as string)]).toHaveLength(24);
    expect(line?.startsWith('·'.repeat(8))).toBe(true);
    expect(line?.[16]).toBe('█'); // the busiest hour
    expect(tens?.[0]).toBe('0');
    expect(ones?.[3]).toBe('3');
    expect(hourChart(new Array(24).fill(0))[0]).toBe('·'.repeat(24));
  });

  it('durations use the two largest units', () => {
    expect(dur(0)).toBe('0s');
    expect(dur(45)).toBe('45s');
    expect(dur(60)).toBe('1m');
    expect(dur(3600)).toBe('1h');
    expect(dur(3660)).toBe('1h 1m');
    expect(dur(86400)).toBe('1d');
    expect(dur(90061)).toBe('1d 1h');
  });
});

describe('hourkeep stats', () => {
  const io = (reply: unknown): { io: CliIo; calls: unknown[]; out: string[]; err: string[] } => {
    const calls: unknown[] = [];
    const out: string[] = [];
    const err: string[] = [];
    return {
      calls,
      out,
      err,
      io: {
        call: (async (_s: string, op: string, params: unknown) => {
          calls.push({ op, params });
          return reply;
        }) as CliIo['call'],
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        now: () => 0,
        env: {},
        prompt: async () => null,
        sleep: async () => undefined,
        isInteractive: false,
      },
    };
  };
  const good = { v: 3, id: 'x', ok: true, data: stats };

  it('asks for the last week by default and prints the report', async () => {
    const h = io(good);
    expect(await runCli(['stats'], h.io)).toBe(0);
    expect(h.calls).toEqual([{ op: 'stats', params: { range: 'week' } }]);
    expect(h.out.join('')).toContain('Hourkeep stats: last 7 days');
  });

  it.each(['today', 'week', 'month', 'all'])('passes --range %s through', async (range) => {
    const h = io(good);
    await runCli(['stats', '--range', range], h.io);
    expect(h.calls).toEqual([{ op: 'stats', params: { range } }]);
  });

  it('rejects an unknown range as bad usage without calling the daemon', async () => {
    const h = io(good);
    expect(await runCli(['stats', '--range', 'decade'], h.io)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join('')).toContain('decade');
  });

  it('--json prints the data object untouched', async () => {
    const h = io(good);
    expect(await runCli(['--json', 'stats', '--range', 'today'], h.io)).toBe(0);
    expect(JSON.parse(h.out.join(''))).toEqual({ ok: true, data: stats });
  });

  it('reports a daemon error', async () => {
    const h = io({
      v: 3,
      id: 'x',
      ok: false,
      error: { code: 'internal', message: 'internal error' },
    });
    expect(await runCli(['stats'], h.io)).toBe(1);
    expect(h.err.join('')).toContain('internal error');
  });
});
