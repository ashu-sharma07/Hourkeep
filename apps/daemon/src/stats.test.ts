import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_GROUPS,
  DEFAULT_SETTINGS,
  seededRng,
  slotStart,
  type SuffixSpec,
} from '@hourkeep/core';
import type { ScheduleWire } from '@hourkeep/ipc';
import { HostsFileEnforcer } from '@hourkeep/platform';
import { parseScheduleSpec } from '@hourkeep/core';
import { Engine, type DnsPort } from './engine.js';
import { Store } from './store.js';
import {
  FakeClock,
  HOSTS_BASE,
  MINUTE,
  SECOND,
  makeSandbox,
  silent,
  solve,
  type Sandbox,
} from './test-helpers.js';

const UID = 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let sb: Sandbox;
let clock: FakeClock;
let store: Store;
let engine: Engine;
let dnsCalls: SuffixSpec[];
let flushes: number;
let seed = 100;

const port: DnsPort = {
  setSpec: (s) => dnsCalls.push(s),
  flush: () => void flushes++,
  status: () => ({
    enabled: true,
    listening: '127.0.0.1:53',
    strategy: 'resolv.conf',
    inEffect: true,
    upstreamCount: 2,
    problem: null,
  }),
};

function make(tz = 'UTC', withDns = true): Engine {
  return new Engine({
    store,
    enforcer: new HostsFileEnforcer({ root: sb.root, dryRun: false }),
    groups: BUILTIN_GROUPS,
    logger: silent,
    dryRun: false,
    defaults: { ...DEFAULT_SETTINGS, timezone: tz },
    challengeKinds: ['typing'],
    clock: clock.now,
    bootClock: clock.now,
    rng: seededRng(seed++),
    intervalMs: 5000,
    ...(withDns ? { dns: port } : {}),
  });
}

beforeEach(async () => {
  sb = makeSandbox();
  clock = new FakeClock(Date.parse('2026-10-14T12:00:00Z')); // Wednesday
  store = Store.open(':memory:');
  dnsCalls = [];
  flushes = 0;
  engine = make();
  await engine.start();
});
afterEach(() => {
  store.close();
  sb.cleanup();
});

const must = <T>(r: { ok: true; value: T } | { ok: false; code: string; message: string }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const sched = (spec: string[]): ScheduleWire => {
  const r = parseScheduleSpec(spec, 'UTC');
  if (!r.ok) throw new Error(r.error);
  return r.value as unknown as ScheduleWire;
};
const pendingId = (
  o:
    | { ok: true; value: { status: string; change?: { id: number } } }
    | { ok: false; code: string; message: string },
): number => {
  const v = must(o);
  if (v.status !== 'pending' || !v.change) throw new Error('not pending');
  return v.change.id;
};
/** Run the periodic check `n` times, `ms` apart. */
async function ticks(n: number, ms = 5 * SECOND) {
  for (let i = 0; i < n; i++) {
    clock.advance(ms);
    await engine.verify();
  }
}
async function confirm(id: number, wrongFirst = 0) {
  clock.advance(10 * MINUTE);
  const c = must(await engine.challengeFor(id));
  clock.advance(10 * SECOND);
  for (let i = 0; i < wrongFirst; i++) must(await engine.answer(id, 'wrong', UID));
  must(await engine.answer(id, solve(c.challenge), UID));
}
const tamper = () => fs.writeFileSync(sb.hosts, HOSTS_BASE);

describe('an empty database', () => {
  it('gives zeros, empty lists, 24 hours and no streak', () => {
    const s = engine.stats('all');
    expect(s).toMatchObject({
      range: 'all',
      to: '2026-10-14',
      timezone: 'UTC',
      dns: { enabled: true, blocked: 0, forwarded: 0, byRule: [], bySuffix: [], daily: [] },
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
    expect(s.dns.hourOfDay).toEqual(new Array(24).fill(0));
  });

  it('says the DNS layer is off when there is none', async () => {
    const plain = make('UTC', false);
    expect(plain.stats('today').dns.enabled).toBe(false);
    expect(plain.status().dns).toMatchObject({ enabled: false, listening: null, blockedToday: 0 });
  });
});

describe('blocked lookups', () => {
  const rule = (kind: 'group' | 'domain', target: string) => ({ kind, target }) as const;
  const at = (iso: string) => slotStart(Date.parse(iso));

  beforeEach(() => {
    const add = (iso: string, suffix: string, r: ReturnType<typeof rule>, n: number) =>
      store.addDnsBlocked(at(iso), suffix, r, n);
    add('2026-10-14T09:00:00Z', 'googlevideo.com', rule('group', 'youtube'), 30); // today
    add('2026-10-14T09:15:00Z', 'googlevideo.com', rule('group', 'youtube'), 5);
    add('2026-10-14T21:30:00Z', 'youtube.com', rule('group', 'youtube'), 4);
    add('2026-10-14T21:30:00Z', 'reddit.com', rule('domain', 'reddit.com'), 2);
    add('2026-10-10T15:00:00Z', 'googlevideo.com', rule('group', 'youtube'), 10); // 4 days ago
    add('2026-09-20T15:00:00Z', 'reddit.com', rule('domain', 'reddit.com'), 8); // 24 days ago
    add('2026-08-01T15:00:00Z', 'reddit.com', rule('domain', 'reddit.com'), 100); // long ago
    store.addDnsTotals(at('2026-10-14T09:00:00Z'), 400, 3);
    store.addDnsTotals(at('2026-10-10T15:00:00Z'), 250, 0);
    store.addDnsTotals(at('2026-08-01T15:00:00Z'), 1000, 0);
  });

  it('today covers only the current local day', () => {
    const s = engine.stats('today');
    expect(s.dns).toMatchObject({ blocked: 41, forwarded: 400 });
    expect(s.from).toBe('2026-10-14');
    expect(s.dns.byRule).toEqual([
      { kind: 'group', target: 'youtube', blocked: 39 },
      { kind: 'domain', target: 'reddit.com', blocked: 2 },
    ]);
    expect(s.dns.bySuffix).toEqual([
      { suffix: 'googlevideo.com', blocked: 35 },
      { suffix: 'youtube.com', blocked: 4 },
      { suffix: 'reddit.com', blocked: 2 },
    ]);
    expect(s.dns.daily).toEqual([{ day: '2026-10-14', blocked: 41 }]);
  });

  it('week, month and all widen the window', () => {
    expect(engine.stats('week').dns).toMatchObject({ blocked: 51, forwarded: 650 });
    expect(engine.stats('month').dns).toMatchObject({ blocked: 59, forwarded: 650 });
    expect(engine.stats('all').dns).toMatchObject({ blocked: 159, forwarded: 1650 });
    expect(engine.stats('week').from).toBe('2026-10-08');
    expect(engine.stats('month').dns.daily.map((d) => d.day)).toEqual([
      '2026-09-20',
      '2026-10-10',
      '2026-10-14',
    ]);
  });

  it('breaks the day into local hours', () => {
    const h = engine.stats('today').dns.hourOfDay;
    expect(h[9]).toBe(35);
    expect(h[21]).toBe(6);
    expect(h.reduce((a, b) => a + b, 0)).toBe(41);
  });

  it('uses the timezone setting for hours and days, including half-hour offsets', () => {
    store.setSetting('timezone', 'Asia/Kolkata'); // UTC+5:30
    const s = engine.stats('today'); // 12:00Z = 17:30 IST, still the 14th
    expect(s.timezone).toBe('Asia/Kolkata');
    expect(s.dns.hourOfDay[14]).toBe(35); // 09:00Z = 14:30 IST and 09:15Z = 14:45 IST
    expect(s.dns.hourOfDay[3]).toBe(6); // 21:30Z = 03:00 IST (the next morning)
  });

  it('puts a late-evening UTC bucket on the next local day east of Greenwich', () => {
    store.setSetting('timezone', 'Asia/Kolkata');
    const s = engine.stats('week');
    // 21:30Z on the 14th is 03:00 on the 15th in India: tomorrow, i.e. after "today" ends its range window
    expect(s.dns.daily.find((d) => d.day === '2026-10-15')).toMatchObject({ blocked: 6 });
  });

  it('status reports how many were blocked today', () => {
    expect(engine.status().dns).toMatchObject({
      enabled: true,
      listening: '127.0.0.1:53',
      inEffect: true,
      upstreamCount: 2,
      blockedToday: 41,
    });
  });

  it('flushes the DNS counters before reading', () => {
    const before = flushes;
    engine.stats('today');
    engine.status();
    expect(flushes).toBe(before + 2);
  });

  it('shows suffixes and rules, never anything that looks like a looked-up name', () => {
    const s = JSON.stringify(engine.stats('all'));
    expect(s).not.toMatch(/rr1|private|qname/);
  });
});

describe('the DNS layer follows what is blocking', () => {
  it('gets the whole-domain spec at start and again only when it changes', async () => {
    expect(dnsCalls).toHaveLength(1);
    expect(dnsCalls[0]).toEqual({ block: [], allow: [] });
    must(await engine.block('youtube', UID));
    expect(dnsCalls).toHaveLength(2);
    const spec = dnsCalls[1] as SuffixSpec;
    expect(spec.block.map((e) => e.suffix)).toContain('googlevideo.com');
    expect(spec.allow).toEqual(['accounts.youtube.com', 'consent.youtube.com']);
    await ticks(5);
    expect(dnsCalls).toHaveLength(2); // nothing changed, nothing sent
  });

  it('empties during a pass and comes back, and follows a schedule', async () => {
    must(await engine.block('youtube', UID));
    const pass = must(await engine.requestPass('youtube', UID));
    const pid = pass.status === 'pending' ? pass.change.id : -1;
    const c = must(await engine.challengeFor(pid));
    clock.advance(6 * SECOND);
    must(await engine.answer(pid, solve(c.challenge), UID));
    expect((dnsCalls.at(-1) as SuffixSpec).block).toEqual([]);
    await ticks(1, 16 * MINUTE);
    expect((dnsCalls.at(-1) as SuffixSpec).block.length).toBeGreaterThan(0);

    const s = must(await engine.requestSchedule('youtube', sched(['mon-fri 09:00-17:00']), UID));
    await confirm(s.status === 'pending' ? s.change.id : -1);
    clock.set('2026-10-14T20:00:00Z');
    await engine.verify();
    expect((dnsCalls.at(-1) as SuffixSpec).block).toEqual([]);
    clock.set('2026-10-15T10:00:00Z');
    await engine.verify();
    expect((dnsCalls.at(-1) as SuffixSpec).block.length).toBeGreaterThan(0);
  });

  it('a domain rule is a whole-domain suffix with no www. added', async () => {
    must(await engine.block('reddit.com', UID));
    expect((dnsCalls.at(-1) as SuffixSpec).block.map((e) => e.suffix)).toEqual(['reddit.com']);
  });
});

describe('time in each state', () => {
  it('credits the seconds between checks to the rule state', async () => {
    must(await engine.block('youtube', UID));
    await ticks(12); // 60 s
    const r = engine.stats('today').time.rules[0];
    expect(r).toMatchObject({
      kind: 'group',
      target: 'youtube',
      blockingSeconds: 60,
      passSeconds: 0,
      scheduledOffSeconds: 0,
    });
  });

  it('splits it into blocking, pass and scheduled off', async () => {
    must(await engine.block('youtube', UID));
    await ticks(6); // 30 s blocking
    const p = must(await engine.requestPass('youtube', UID));
    const pid = p.status === 'pending' ? p.change.id : -1;
    const c = must(await engine.challengeFor(pid));
    clock.advance(6 * SECOND);
    must(await engine.answer(pid, solve(c.challenge), UID));
    await ticks(4); // 20 s on a pass
    must(await engine.endPass('youtube', UID));
    const s = must(await engine.requestSchedule('youtube', sched(['mon-fri 23:00-23:30']), UID));
    await confirm(s.status === 'pending' ? s.change.id : -1);
    await ticks(3); // 15 s outside the window (it is about 12:15)
    const r = engine.stats('today').time.rules[0];
    // The step across the challenge (11 s) is more than two intervals, so it is not credited:
    // 3 of the 4 pass ticks count.
    expect(r?.passSeconds).toBe(15);
    expect(r?.scheduledOffSeconds).toBe(10); // likewise, the first check after the 10 minute cooldown wait is a gap
    expect(r?.blockingSeconds).toBeGreaterThanOrEqual(30);
  });

  it('does not credit a gap: the daemon was down or the machine slept', async () => {
    must(await engine.block('youtube', UID));
    await ticks(2); // 10 s
    await ticks(1, 3 * HOUR); // one huge step
    await ticks(2); // 10 s
    expect(engine.stats('today').time.rules[0]?.blockingSeconds).toBe(20);
  });

  it('counts cooldown time only while something is waiting', async () => {
    must(await engine.block('youtube', UID));
    await ticks(2); // nothing pending
    must(await engine.requestUnblock('youtube', UID));
    await ticks(6, 5 * SECOND); // 30 s inside the 10 minute cooldown
    expect(engine.stats('today').time.cooldownSeconds).toBe(30);
    clock.advance(11 * MINUTE);
    await engine.verify(); // gap, not credited, and the cooldown is over now
    await ticks(2);
    expect(engine.stats('today').time.cooldownSeconds).toBe(30);
  });

  it('keeps days apart', async () => {
    must(await engine.block('youtube', UID));
    await ticks(2);
    clock.set('2026-10-15T08:00:00Z');
    await engine.verify();
    await ticks(2);
    expect(engine.stats('today').time.rules[0]?.blockingSeconds).toBe(10);
    expect(engine.stats('week').time.rules[0]?.blockingSeconds).toBe(20);
  });
});

describe('friction', () => {
  it('counts requests, applications, cancellations and expiries, by kind', async () => {
    must(await engine.block('youtube', UID));
    must(await engine.block('reddit.com', UID));
    const a = pendingId(await engine.requestUnblock('youtube', UID));
    await confirm(a); // applied
    const b = pendingId(await engine.requestUnblock('reddit.com', UID));
    must(await engine.cancelPending(b, UID)); // cancelled
    pendingId(await engine.requestSetting('timezone', 'Asia/Tokyo', UID)); // will expire
    clock.advance(45 * MINUTE);
    await engine.verify();
    const f = engine.stats('today').friction;
    expect(f).toMatchObject({
      requested: 3,
      applied: 1,
      cancelled: 1,
      expired: 1,
      passesStarted: 0,
    });
    expect(f.byChange).toEqual([
      { kind: 'remove_rule', requested: 2, applied: 1 },
      { kind: 'set_setting', requested: 1, applied: 0 },
    ]);
  });

  it('reports issued, solved and wrong answers per challenge type with a solve rate', async () => {
    must(await engine.block('youtube', UID));
    must(await engine.block('reddit.com', UID));
    await confirm(pendingId(await engine.requestUnblock('youtube', UID)), 2); // 2 wrong, then solved
    const abandoned = pendingId(await engine.requestUnblock('reddit.com', UID));
    clock.advance(10 * MINUTE);
    must(await engine.challengeFor(abandoned)); // issued, never solved
    const typing = engine.stats('today').friction.challenges.find((c) => c.kind === 'typing');
    expect(typing).toEqual({
      kind: 'typing',
      issued: 2,
      solved: 1,
      wrongAnswers: 2,
      solveRate: 50,
    });
  });

  it('counts a pass as started, not as a loosening change', async () => {
    must(await engine.block('youtube', UID));
    const p = must(await engine.requestPass('youtube', UID));
    const pid = p.status === 'pending' ? p.change.id : -1;
    const c = must(await engine.challengeFor(pid));
    clock.advance(6 * SECOND);
    must(await engine.answer(pid, solve(c.challenge), UID));
    expect(engine.stats('today').friction).toMatchObject({ passesStarted: 1, applied: 1 });
  });

  it('respects the range', async () => {
    must(await engine.block('youtube', UID));
    await confirm(pendingId(await engine.requestUnblock('youtube', UID)));
    clock.advance(5 * DAY);
    expect(engine.stats('today').friction.requested).toBe(0);
    expect(engine.stats('week').friction.requested).toBe(1);
  });
});

describe('tamper', () => {
  it('counts tamper per day and clock jumps separately', async () => {
    must(await engine.block('youtube', UID));
    await ticks(1);
    tamper();
    await ticks(1);
    clock.set('2026-10-15T10:00:00Z');
    await engine.verify();
    tamper();
    await ticks(1);
    tamper();
    await ticks(1);
    const t = engine.stats('week').tamper;
    expect(t.count).toBe(3);
    expect(t.byDay).toEqual([
      { day: '2026-10-14', count: 1 },
      { day: '2026-10-15', count: 2 },
    ]);
    expect(engine.stats('today').tamper.count).toBe(2);
  });
});

describe('streak', () => {
  const protectedDay = async () => {
    await ticks(2);
  };

  it('counts consecutive clean days up to today', async () => {
    must(await engine.block('youtube', UID));
    for (const d of ['2026-10-14', '2026-10-15', '2026-10-16']) {
      clock.set(`${d}T08:00:00Z`);
      await engine.verify();
      await protectedDay();
    }
    expect(engine.stats('all').streak).toEqual({
      current: 3,
      longest: 3,
      cleanDays: 3,
      totalDays: 3,
    });
  });

  it('a tamper day breaks it, and it grows again afterwards', async () => {
    must(await engine.block('youtube', UID));
    clock.set('2026-10-14T08:00:00Z');
    await engine.verify();
    await protectedDay();
    clock.set('2026-10-15T08:00:00Z');
    await engine.verify();
    tamper();
    await ticks(1);
    clock.set('2026-10-16T08:00:00Z');
    await engine.verify();
    await protectedDay();
    clock.set('2026-10-17T08:00:00Z');
    await engine.verify();
    await protectedDay();
    expect(engine.stats('all').streak).toEqual({
      current: 2,
      longest: 2,
      cleanDays: 3,
      totalDays: 4,
    });
  });

  it('a passes day stays clean, but a loosening change applied does not', async () => {
    must(await engine.block('youtube', UID));
    must(await engine.block('reddit.com', UID));
    clock.set('2026-10-14T08:00:00Z');
    await engine.verify();
    const p = must(await engine.requestPass('youtube', UID));
    const pid = p.status === 'pending' ? p.change.id : -1;
    const c = must(await engine.challengeFor(pid));
    clock.advance(6 * SECOND);
    must(await engine.answer(pid, solve(c.challenge), UID));
    await protectedDay();
    expect(engine.stats('all').streak.current).toBe(1); // passes are the allowed path

    clock.set('2026-10-15T08:00:00Z');
    await engine.verify();
    await protectedDay();
    await confirm(pendingId(await engine.requestUnblock('reddit.com', UID)));
    expect(engine.stats('all').streak).toMatchObject({ current: 0, longest: 1 });
  });

  it('a day with no rules or no daemon is not clean', async () => {
    await ticks(3); // no rules yet: not protected
    expect(engine.stats('all').streak).toMatchObject({ current: 0, cleanDays: 0 });
  });
});
