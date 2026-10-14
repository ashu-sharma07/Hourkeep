import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_GROUPS,
  DEFAULT_SETTINGS,
  parseScheduleSpec,
  seededRng,
  type ChallengeKindId,
  type Settings,
  type Timing,
} from '@hourkeep/core';
import type { ChangeOutcome, ScheduleWire } from '@hourkeep/ipc';
import { HostsFileEnforcer, renderBlock } from '@hourkeep/platform';
import { Engine, type Res } from './engine.js';
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
const DEFAULTS: Settings = { ...DEFAULT_SETTINGS, timezone: 'UTC' };
const ytDomains = () =>
  [...(BUILTIN_GROUPS.groups.find((g) => g.id === 'youtube')?.domains ?? [])].sort();

let sb: Sandbox;
let clock: FakeClock;
let boot: FakeClock;
let store: Store;
let engine: Engine;
let seed = 1;

interface Opts {
  kinds?: ChallengeKindId[];
  timing?: Partial<Timing>;
  dryRun?: boolean;
  defaults?: Settings;
}

function makeEngine(s: Store, o: Opts = {}): Engine {
  return new Engine({
    store: s,
    enforcer: new HostsFileEnforcer({ root: sb.root, dryRun: o.dryRun ?? false }),
    groups: BUILTIN_GROUPS,
    logger: silent,
    dryRun: o.dryRun ?? false,
    defaults: o.defaults ?? DEFAULTS,
    challengeKinds: o.kinds ?? ['typing'],
    ...(o.timing ? { timing: o.timing } : {}),
    clock: clock.now,
    bootClock: boot.now,
    rng: seededRng(seed++),
  });
}

beforeEach(async () => {
  sb = makeSandbox();
  clock = new FakeClock();
  boot = new FakeClock(0);
  store = Store.open(':memory:');
  engine = makeEngine(store);
  await engine.start();
});
afterEach(() => {
  store.close();
  sb.cleanup();
});

const hosts = () => fs.readFileSync(sb.hosts, 'utf8');
const advance = (ms: number) => {
  clock.advance(ms);
  boot.advance(ms);
};
/** Move time and run the periodic check, as the daemon's timer would. */
const tick = async (ms = 0) => {
  advance(ms);
  await engine.verify();
};

function must<T>(r: Res<T>): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}
const pendingOf = (o: Res<ChangeOutcome>) => {
  const v = must(o);
  if (v.status !== 'pending') throw new Error(`expected pending, got ${JSON.stringify(v)}`);
  return v.change;
};
const appliedOf = (o: Res<ChangeOutcome>) => {
  const v = must(o);
  if (v.status !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(v)}`);
  return v.message;
};

/** Cooldown, challenge, correct answer: the whole path for a loosening change. */
async function confirm(id: number): Promise<string> {
  advance(10 * MINUTE);
  const c = must(await engine.challengeFor(id));
  advance(40 * SECOND);
  const a = must(await engine.answer(id, solve(c.challenge), UID));
  if (!('result' in a)) throw new Error('answer was wrong');
  return a.message;
}

const sched = (specs: string[], tz = 'UTC'): ScheduleWire => {
  const r = parseScheduleSpec(specs, tz);
  if (!r.ok) throw new Error(r.error);
  return r.value as unknown as ScheduleWire;
};
const goto = (iso: string) => advance(Date.parse(iso) - clock.t);
const kinds = (type: Parameters<Store['events']>[0]) => store.events(type);

/** Put a schedule on a rule the way a user must: through cooldown and challenge. */
async function scheduleVia(target: string, spec: string[]) {
  const change = pendingOf(await engine.requestSchedule(target, sched(spec), UID));
  await confirm(change.id);
}

/** Request a pass and complete its challenge (no cooldown for passes). */
async function takePass(target: string): Promise<string> {
  const change = pendingOf(await engine.requestPass(target, UID));
  const c = must(await engine.challengeFor(change.id));
  advance(6 * SECOND);
  const a = must(await engine.answer(change.id, solve(c.challenge), UID));
  if (!('result' in a)) throw new Error('wrong answer');
  return a.message;
}

describe('tightening is instant', () => {
  it('adding a rule applies at once', async () => {
    const r = must(await engine.block('youtube', UID));
    expect(r.added).toBe(true);
    expect(hosts()).toBe(HOSTS_BASE + renderBlock(ytDomains()));
  });

  it('widening or clearing a schedule applies at once', async () => {
    must(await engine.block('youtube', UID));
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    expect(
      appliedOf(await engine.requestSchedule('youtube', sched(['mon-fri 08:00-18:00']), UID)),
    ).toContain('08:00-18:00');
    expect(appliedOf(await engine.requestSchedule('youtube', null, UID))).toContain('always');
    expect(engine.listPending()).toEqual([]);
  });

  it('lowering a limit, raising the cooldown and lowering passes per day apply at once', async () => {
    must(await engine.block('youtube', UID));
    appliedOf(await engine.requestLimit('youtube', 30, UID)); // no limit -> 30 is tighter
    appliedOf(await engine.requestLimit('youtube', 20, UID));
    appliedOf(await engine.requestSetting('cooldown', '30', UID));
    appliedOf(await engine.requestSetting('passes-per-day', '2', UID));
    appliedOf(await engine.requestSetting('pass-minutes', '10', UID));
    expect(engine.settings()).toMatchObject({
      cooldownSeconds: 1800,
      passesPerDay: 2,
      passMinutes: 10,
    });
    expect(engine.listPending()).toEqual([]);
  });

  it('asking for something that changes nothing is a no-op', async () => {
    must(await engine.block('youtube', UID));
    expect(must(await engine.requestLimit('youtube', null, UID)).status).toBe('noop');
    expect(must(await engine.requestSchedule('youtube', null, UID)).status).toBe('noop');
    expect(must(await engine.requestSetting('cooldown', '10', UID)).status).toBe('noop');
  });
});

describe('loosening goes through cooldown and challenge', () => {
  beforeEach(async () => {
    must(await engine.block('youtube', UID));
  });

  it('unblock only creates a pending change; nothing is unblocked yet', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    expect(c).toMatchObject({
      kind: 'remove_rule',
      summary: 'stop blocking youtube',
      requestedByUid: UID,
      phase: 'cooldown',
      challengeIssued: false,
      attemptsLeft: 3,
      cooldownEndsAt: clock.t + 10 * MINUTE,
      expiresAt: clock.t + 40 * MINUTE,
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(engine.list().rules).toHaveLength(1);
  });

  it('the challenge cannot be fetched during the cooldown', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(9 * MINUTE + 59 * SECOND);
    expect(await engine.challengeFor(c.id)).toMatchObject({
      ok: false,
      code: 'cooldown_active',
      message: expect.stringContaining('1s'),
    });
    expect(await engine.answer(c.id, 'anything', UID)).toMatchObject({
      ok: false,
      code: 'cooldown_active',
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('after the cooldown a challenge is issued, and it is stable until answered', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    const first = must(await engine.challengeFor(c.id));
    const again = must(await engine.challengeFor(c.id));
    expect(again.challenge).toEqual(first.challenge);
    expect(first.attemptsLeft).toBe(3);
    expect(engine.listPending()[0]).toMatchObject({ phase: 'ready', challengeIssued: true });
    expect(first.challenge.instructions).toContain('stop blocking youtube');
  });

  it('the right answer applies the change; the hosts file and rule list update', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    expect(await confirm(c.id)).toBe('Stopped blocking youtube.');
    expect(hosts()).toBe(HOSTS_BASE);
    expect(engine.list().rules).toEqual([]);
    expect(engine.listPending()).toEqual([]);
    expect(kinds('change_requested')).toHaveLength(1);
    expect(kinds('challenge_issued')).toHaveLength(1);
    expect(kinds('change_applied')).toMatchObject([
      { uid: UID, payload: { kind: 'remove_rule', requestedBy: UID } },
    ]);
    expect(kinds('rule_removed')).toHaveLength(1);
  });

  it('rejects an answer that arrives too soon without using up an attempt', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    const ch = must(await engine.challengeFor(c.id));
    advance(2 * SECOND);
    expect(await engine.answer(c.id, solve(ch.challenge), UID)).toMatchObject({
      ok: false,
      code: 'too_early',
    });
    expect(engine.listPending()[0]?.attemptsLeft).toBe(3);
    advance(4 * SECOND);
    expect(must(await engine.answer(c.id, solve(ch.challenge), UID))).toMatchObject({
      result: 'applied',
    });
  });

  it('counts wrong answers and issues a fresh challenge when attempts run out', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    const first = must(await engine.challengeFor(c.id)).challenge;
    advance(10 * SECOND);
    const w1 = must(await engine.answer(c.id, 'wrong', UID));
    expect(w1).toMatchObject({ status: 'wrong', attemptsLeft: 2, newChallenge: null });
    const w2 = must(await engine.answer(c.id, 'wrong', UID));
    expect(w2).toMatchObject({ status: 'wrong', attemptsLeft: 1, newChallenge: null });
    const w3 = must(await engine.answer(c.id, 'wrong', UID));
    expect(w3).toMatchObject({ status: 'wrong', attemptsLeft: 3 });
    const fresh = 'newChallenge' in w3 ? w3.newChallenge : null;
    expect(fresh).not.toBeNull();
    expect(fresh?.id).not.toBe(first.id);
    expect(fresh && solve(fresh)).not.toBe(solve(first));
    expect(kinds('challenge_failed')).toHaveLength(3);
    // the old answer no longer works against the new challenge
    advance(10 * SECOND);
    expect(must(await engine.answer(c.id, solve(first), UID))).toMatchObject({ status: 'wrong' });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('answering before asking for a challenge is refused', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    expect(await engine.answer(c.id, 'x', UID)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('can be cancelled during the cooldown; nothing changes and the id is dead', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    const r = must(await engine.cancelPending(c.id, UID));
    expect(r).toContain('Cancelled');
    expect(engine.listPending()).toEqual([]);
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    advance(10 * MINUTE);
    expect(await engine.challengeFor(c.id)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await engine.cancelPending(c.id, UID)).toMatchObject({ ok: false, code: 'not_found' });
    expect(kinds('change_cancelled')).toHaveLength(1);
  });

  it('can be cancelled after the challenge was issued', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    const ch = must(await engine.challengeFor(c.id));
    must(await engine.cancelPending(c.id, UID));
    advance(10 * SECOND);
    expect(await engine.answer(c.id, solve(ch.challenge), UID)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('expires if not confirmed within 30 minutes of the cooldown ending', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(10 * MINUTE + 30 * MINUTE - 1);
    expect(engine.listPending()).toHaveLength(1);
    advance(1);
    expect(engine.listPending()).toEqual([]);
    expect(await engine.challengeFor(c.id)).toMatchObject({ ok: false, code: 'expired' });
    expect(kinds('change_expired')).toHaveLength(1);
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    // a new request starts a new cooldown
    const again = pendingOf(await engine.requestUnblock('youtube', UID));
    expect(again.id).not.toBe(c.id);
    expect(again.phase).toBe('cooldown');
  });

  it('the periodic check expires stale requests too', async () => {
    pendingOf(await engine.requestUnblock('youtube', UID));
    await tick(41 * MINUTE);
    expect(kinds('change_expired')).toHaveLength(1);
    expect(engine.status().pendingCount).toBe(0);
  });

  it('a repeated request returns the existing pending change instead of restarting the clock', async () => {
    const a = pendingOf(await engine.requestUnblock('youtube', UID));
    advance(5 * MINUTE);
    const b = pendingOf(await engine.requestUnblock('youtube', 2000));
    expect(b.id).toBe(a.id);
    expect(b.cooldownEndsAt).toBe(a.cooldownEndsAt);
    expect(engine.listPending()).toHaveLength(1);
  });

  it('a confirmed change cannot be confirmed twice', async () => {
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    await confirm(c.id);
    expect(await engine.challengeFor(c.id)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('reports unknown rules and bad targets without creating anything', async () => {
    expect(await engine.requestUnblock('example.com', UID)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await engine.requestUnblock('*.x.com', UID)).toMatchObject({
      ok: false,
      code: 'invalid_target',
    });
    expect(await engine.cancelPending(99, UID)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await engine.challengeFor(99)).toMatchObject({ ok: false, code: 'not_found' });
    expect(engine.listPending()).toEqual([]);
  });

  it('a stale request is dropped if the world changed while it waited', async () => {
    appliedOf(await engine.requestLimit('youtube', 10, UID));
    const raise = pendingOf(await engine.requestLimit('youtube', 20, UID)); // loosening
    const remove = pendingOf(await engine.requestUnblock('youtube', UID));
    await confirm(remove.id);
    advance(MINUTE);
    const ch = must(await engine.challengeFor(raise.id));
    advance(10 * SECOND);
    expect(await engine.answer(raise.id, solve(ch.challenge), UID)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(engine.listPending()).toEqual([]);
    expect(kinds('change_cancelled')).toHaveLength(1);
  });

  describe('challenge kinds', () => {
    it('arithmetic can be solved from what is shown', async () => {
      engine = makeEngine(store, { kinds: ['arithmetic'] });
      await engine.start();
      const c = pendingOf(await engine.requestUnblock('youtube', UID));
      expect(await confirm(c.id)).toBe('Stopped blocking youtube.');
    });

    it('reflection makes you wait, and the reason is logged', async () => {
      engine = makeEngine(store, { kinds: ['reflection'] });
      await engine.start();
      const c = pendingOf(await engine.requestUnblock('youtube', UID));
      advance(10 * MINUTE);
      const ch = must(await engine.challengeFor(c.id));
      expect(ch.challenge.data.kind).toBe('reflection');
      advance(29 * SECOND);
      expect(await engine.answer(c.id, solve(ch.challenge), UID)).toMatchObject({
        ok: false,
        code: 'too_early',
      });
      advance(SECOND);
      expect(must(await engine.answer(c.id, solve(ch.challenge), UID))).toMatchObject({
        result: 'applied',
      });
      expect(kinds('change_applied')[0]?.payload).toMatchObject({
        reflection: expect.stringContaining('deadline'),
      });
    });

    it('timing is configurable', async () => {
      engine = makeEngine(store, { kinds: ['reflection'], timing: { reflectionWaitMs: 2000 } });
      await engine.start();
      const c = pendingOf(await engine.requestUnblock('youtube', UID));
      advance(10 * MINUTE);
      const ch = must(await engine.challengeFor(c.id));
      advance(2 * SECOND);
      expect(must(await engine.answer(c.id, solve(ch.challenge), UID))).toMatchObject({
        result: 'applied',
      });
    });
  });
});

describe('the cooldown is itself protected', () => {
  it('uses the configured cooldown, and a longer one applies to later requests', async () => {
    must(await engine.block('youtube', UID));
    appliedOf(await engine.requestSetting('cooldown', '30', UID));
    const c = pendingOf(await engine.requestUnblock('youtube', UID));
    expect(c.cooldownEndsAt - c.requestedAt).toBe(30 * MINUTE);
  });

  it('shortening the cooldown needs the old cooldown; requests made meanwhile keep the old one', async () => {
    must(await engine.block('youtube', UID));
    const shorten = pendingOf(await engine.requestSetting('cooldown', '1', UID));
    expect(shorten.cooldownEndsAt - shorten.requestedAt).toBe(10 * MINUTE);
    expect(engine.settings().cooldownSeconds).toBe(600);
    const unblock = pendingOf(await engine.requestUnblock('youtube', UID));
    expect(unblock.cooldownEndsAt - unblock.requestedAt).toBe(10 * MINUTE);
    await confirm(shorten.id);
    expect(engine.settings().cooldownSeconds).toBe(60);
    // the earlier request keeps its stored cooldown, but new ones are short
    expect(engine.listPending()[0]?.cooldownEndsAt).toBe(unblock.cooldownEndsAt);
    const next = pendingOf(
      await engine.requestSchedule('youtube', sched(['mon 09:00-10:00']), UID),
    );
    expect(next.cooldownEndsAt - next.requestedAt).toBe(60_000);
  });

  it('timezone changes and raising passes are loosening', async () => {
    pendingOf(await engine.requestSetting('timezone', 'Asia/Tokyo', UID));
    pendingOf(await engine.requestSetting('passes-per-day', '5', UID));
    pendingOf(await engine.requestSetting('pass-minutes', '30', UID));
    expect(engine.settings()).toMatchObject({ timezone: 'UTC', passesPerDay: 3, passMinutes: 15 });
  });

  it('rejects bad values without creating a request', async () => {
    expect(await engine.requestSetting('cooldown', '0', UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
    expect(await engine.requestSetting('cooldown', 'soon', UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
    expect(await engine.requestSetting('colour', 'red', UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
    expect(await engine.requestSetting('timezone', 'Mars/Base', UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
    expect(engine.listPending()).toEqual([]);
  });

  it('defaults only seed a fresh database', async () => {
    const other = makeEngine(store, {
      defaults: { ...DEFAULTS, cooldownSeconds: 5, passesPerDay: 99, timezone: 'Asia/Tokyo' },
    });
    await other.start();
    expect(other.settings()).toMatchObject({
      cooldownSeconds: 600,
      passesPerDay: 3,
      timezone: 'UTC',
    });
  });
});

describe('schedules', () => {
  beforeEach(async () => {
    must(await engine.block('youtube', UID));
  });

  it('going from always-on to a schedule is loosening', async () => {
    const c = pendingOf(
      await engine.requestSchedule('youtube', sched(['mon-fri 09:00-17:00']), UID),
    );
    expect(c.summary).toContain('mon-fri 09:00-17:00');
    expect(engine.list().rules[0]?.schedule).toBeNull();
    await confirm(c.id);
    expect(engine.list().rules[0]).toMatchObject({ scheduleText: 'mon-fri 09:00-17:00 (UTC)' });
  });

  it('removing any minute of coverage is loosening; adding coverage is not', async () => {
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    pendingOf(await engine.requestSchedule('youtube', sched(['mon-fri 09:00-16:59']), UID));
    pendingOf(await engine.requestSchedule('youtube', sched(['mon-fri 10:00-18:00']), UID)); // mixed
    appliedOf(
      await engine.requestSchedule(
        'youtube',
        sched(['mon-fri 09:00-17:00', 'sat 10:00-11:00']),
        UID,
      ),
    );
  });

  it('the same schedule written differently is a no-op', async () => {
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    expect(
      must(
        await engine.requestSchedule(
          'youtube',
          sched(['mon-fri 09:00-12:00', 'mon-fri 12:00-17:00']),
          UID,
        ),
      ).status,
    ).toBe('noop');
  });

  it('changing the timezone of a schedule is loosening', async () => {
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    pendingOf(
      await engine.requestSchedule(
        'youtube',
        sched(['mon-fri 09:00-17:00'], 'Pacific/Auckland'),
        UID,
      ),
    );
  });

  it('rejects an invalid schedule', async () => {
    const bad = { timezone: 'Mars/Base', days: sched(['mon 09:00-10:00']).days };
    expect(await engine.requestSchedule('youtube', bad, UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
    const inverted = sched(['mon 09:00-10:00']);
    inverted.days.mon = [{ start: 600, end: 60 }];
    expect(await engine.requestSchedule('youtube', inverted, UID)).toMatchObject({
      ok: false,
      code: 'invalid_value',
    });
  });

  describe('enforcement follows the clock', () => {
    beforeEach(async () => {
      await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    });

    it('blocks inside the window and not outside, with no tamper events', async () => {
      goto('2026-10-14T08:59:00Z'); // Wednesday
      await engine.verify();
      expect(hosts()).toBe(HOSTS_BASE);
      expect(engine.list().rules[0]?.blockingNow).toBe(false);

      await tick(MINUTE); // 09:00
      expect(hosts()).toContain('0.0.0.0 youtube.com');
      expect(engine.list().rules[0]?.blockingNow).toBe(true);

      goto('2026-10-14T16:59:00Z');
      await engine.verify();
      expect(hosts()).toContain('0.0.0.0 youtube.com');
      await tick(MINUTE); // 17:00
      expect(hosts()).toBe(HOSTS_BASE);

      goto('2026-10-17T12:00:00Z'); // Saturday
      await engine.verify();
      expect(hosts()).toBe(HOSTS_BASE);
      expect(store.countEvents('tamper')).toBe(0);
    });

    it('still reverts hand edits inside the window', async () => {
      goto('2026-10-14T10:00:00Z');
      await engine.verify();
      fs.writeFileSync(sb.hosts, HOSTS_BASE);
      await engine.verify();
      expect(hosts()).toContain('0.0.0.0 youtube.com');
      expect(store.countEvents('tamper')).toBe(1);
    });

    it('applies the right state when the daemon starts mid-window or outside it', async () => {
      goto('2026-10-14T10:00:00Z');
      fs.writeFileSync(sb.hosts, HOSTS_BASE);
      const e2 = makeEngine(store);
      await e2.start();
      expect(hosts()).toContain('0.0.0.0 youtube.com');
      goto('2026-10-14T20:00:00Z');
      const e3 = makeEngine(store);
      await e3.start();
      expect(hosts()).toBe(HOSTS_BASE);
      expect(store.countEvents('tamper')).toBe(0);
    });

    it('evaluates the schedule in its own timezone', async () => {
      const kolkata = pendingOf(
        await engine.requestSchedule(
          'youtube',
          sched(['mon-fri 09:00-17:00'], 'Asia/Kolkata'),
          UID,
        ),
      );
      await confirm(kolkata.id);
      goto('2026-10-14T03:29:00Z'); // 08:59 IST
      await engine.verify();
      expect(hosts()).toBe(HOSTS_BASE);
      await tick(MINUTE); // 09:00 IST
      expect(hosts()).toContain('0.0.0.0 youtube.com');
    });
  });

  it('clearing the schedule goes back to always blocking, at once', async () => {
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    goto('2026-10-17T12:00:00Z');
    await engine.verify();
    expect(hosts()).toBe(HOSTS_BASE);
    appliedOf(await engine.requestSchedule('youtube', null, UID));
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });
});

describe('daily limits', () => {
  beforeEach(async () => {
    must(await engine.block('youtube', UID));
  });

  it('raising or removing a limit is loosening; lowering is not', async () => {
    appliedOf(await engine.requestLimit('youtube', 30, UID));
    pendingOf(await engine.requestLimit('youtube', 31, UID));
    pendingOf(await engine.requestLimit('youtube', null, UID));
    appliedOf(await engine.requestLimit('youtube', 0, UID));
    expect(engine.list().rules[0]?.dailyLimitMinutes).toBe(0);
  });

  it('applies a raised limit after the friction flow', async () => {
    appliedOf(await engine.requestLimit('youtube', 10, UID));
    const c = pendingOf(await engine.requestLimit('youtube', 45, UID));
    expect(c.summary).toBe('set the daily limit of youtube to 45 minutes');
    await confirm(c.id);
    expect(engine.list().rules[0]?.dailyLimitMinutes).toBe(45);
  });

  it('rejects limits that are not whole minutes in range', async () => {
    for (const bad of [-1, 1.5, 1441]) {
      expect(await engine.requestLimit('youtube', bad, UID)).toMatchObject({
        ok: false,
        code: 'invalid_value',
      });
    }
  });
});

describe('temporary passes', () => {
  beforeEach(async () => {
    must(await engine.block('youtube', UID));
  });

  it('a pass needs a challenge but no cooldown, and suspends the block', async () => {
    const c = pendingOf(await engine.requestPass('youtube', UID));
    expect(c).toMatchObject({ kind: 'start_pass', phase: 'ready', cooldownEndsAt: c.requestedAt });
    expect(hosts()).toContain('0.0.0.0 youtube.com'); // nothing yet
    const startedAt = clock.t + 6 * SECOND;
    const msg = await takePass('youtube');
    expect(msg).toContain('15m');
    expect(hosts()).toBe(HOSTS_BASE);
    expect(engine.list().rules[0]).toMatchObject({
      blockingNow: false,
      passEndsAt: startedAt + 15 * MINUTE,
    });
    expect(engine.status()).toMatchObject({ passesUsedToday: 1, passesPerDay: 3 });
  });

  it('the block returns by itself when the pass runs out, without a tamper event', async () => {
    await takePass('youtube');
    await tick(14 * MINUTE);
    expect(hosts()).toBe(HOSTS_BASE);
    await tick(MINUTE + SECOND);
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(store.countEvents('tamper')).toBe(0);
    expect(kinds('pass_started')).toHaveLength(1);
    expect(kinds('pass_ended')).toMatchObject([{ payload: { reason: 'expired' } }]);
  });

  it('ending a pass early is instant but still counts as a used pass', async () => {
    await takePass('youtube');
    expect(appliedOf(await engine.endPass('youtube', UID))).toContain('Blocking again');
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(engine.status().passesUsedToday).toBe(1);
    expect(must(await engine.endPass('youtube', UID)).status).toBe('noop');
  });

  it('allows three passes a day and refuses the fourth', async () => {
    for (let i = 0; i < 3; i++) {
      await takePass('youtube');
      await engine.endPass('youtube', UID);
    }
    const r = await engine.requestPass('youtube', UID);
    expect(r).toMatchObject({
      ok: false,
      code: 'limit_reached',
      message: expect.stringContaining('all 3 passes'),
    });
    expect(engine.listPending()).toEqual([]);
  });

  it('the count resets at local midnight', async () => {
    for (let i = 0; i < 3; i++) {
      await takePass('youtube');
      await engine.endPass('youtube', UID);
    }
    goto('2026-10-15T00:01:00Z');
    expect(must(await engine.requestPass('youtube', UID)).status).toBe('pending');
  });

  it('uses the configured timezone for "today"', async () => {
    store.setSetting('timezone', 'Pacific/Kiritimati'); // UTC+14: local midnight is 10:00 UTC
    for (let i = 0; i < 3; i++) {
      await takePass('youtube');
      await engine.endPass('youtube', UID);
    }
    goto('2026-10-15T09:59:00Z'); // a new UTC day, but 23:59 locally: still the same local day
    expect(await engine.requestPass('youtube', UID)).toMatchObject({
      ok: false,
      code: 'limit_reached',
    });
    goto('2026-10-15T10:00:00Z'); // local midnight
    expect(must(await engine.requestPass('youtube', UID)).status).toBe('pending');
  });

  it('a daily limit trims the second pass to the minutes left', async () => {
    appliedOf(await engine.requestLimit('youtube', 20, UID));
    await takePass('youtube');
    await tick(16 * MINUTE); // first pass ran its 15 minutes
    expect(await takePass('youtube')).toContain('5m');
    await tick(6 * MINUTE);
    expect(await engine.requestPass('youtube', UID)).toMatchObject({
      ok: false,
      code: 'limit_reached',
      message: expect.stringContaining('used up'),
    });
  });

  it('counts only the minutes actually used when a pass is ended early', async () => {
    appliedOf(await engine.requestLimit('youtube', 20, UID));
    await takePass('youtube');
    advance(3 * MINUTE);
    await engine.endPass('youtube', UID);
    expect(await takePass('youtube')).toContain('15m'); // 17 left, capped at the 15 minute pass length
  });

  it('a limit of 0 means no passes for that rule', async () => {
    appliedOf(await engine.requestLimit('youtube', 0, UID));
    expect(await engine.requestPass('youtube', UID)).toMatchObject({
      ok: false,
      code: 'limit_reached',
      message: expect.stringContaining('no passes'),
    });
  });

  it('limits belong to the rule: another rule still gets passes', async () => {
    must(await engine.block('reddit.com', UID));
    appliedOf(await engine.requestLimit('youtube', 0, UID));
    expect(must(await engine.requestPass('reddit.com', UID)).status).toBe('pending');
  });

  it('passes-per-day 0 turns passes off', async () => {
    appliedOf(await engine.requestSetting('passes-per-day', '0', UID));
    expect(await engine.requestPass('youtube', UID)).toMatchObject({
      ok: false,
      code: 'limit_reached',
    });
  });

  it('a pass only suspends its own rule', async () => {
    must(await engine.block('reddit.com', UID));
    await takePass('youtube');
    expect(hosts()).toContain('0.0.0.0 reddit.com');
    expect(hosts()).not.toContain('0.0.0.0 youtube.com');
  });

  it('a second pass while one is running, or outside the schedule, is a no-op', async () => {
    await takePass('youtube');
    expect(must(await engine.requestPass('youtube', UID)).status).toBe('noop');
    await engine.endPass('youtube', UID);
    await scheduleVia('youtube', ['mon-fri 09:00-17:00']);
    goto('2026-10-17T12:00:00Z'); // Saturday: not blocking
    expect(must(await engine.requestPass('youtube', UID))).toMatchObject({
      status: 'noop',
      message: expect.stringContaining('not being blocked'),
    });
  });

  it('pass limits are checked again when the challenge is answered', async () => {
    const first = pendingOf(await engine.requestPass('youtube', UID));
    const second = pendingOf(
      await engine
        .requestSetting('passes-per-day', '1', UID)
        .then(() => engine.requestPass('youtube', UID)),
    );
    expect(second.id).toBe(first.id); // same request, not a new one
    appliedOf(await engine.requestLimit('youtube', 0, UID)); // tightened while waiting
    const ch = must(await engine.challengeFor(first.id));
    advance(6 * SECOND);
    expect(await engine.answer(first.id, solve(ch.challenge), UID)).toMatchObject({
      ok: false,
      code: 'limit_reached',
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(engine.listPending()).toEqual([]);
  });

  it('a pass survives a daemon restart', async () => {
    await takePass('youtube');
    const e2 = makeEngine(store);
    await e2.start();
    expect(hosts()).toBe(HOSTS_BASE);
    advance(16 * MINUTE);
    await e2.verify();
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });
});

describe('state survives a restart (database on disk)', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(sb.dir, 'persist.db');
  });

  const restart = async (s: Store): Promise<{ store: Store; engine: Engine }> => {
    s.close();
    const s2 = Store.open(file);
    const e = makeEngine(s2);
    await e.start();
    return { store: s2, engine: e };
  };

  it('keeps a pending change mid-cooldown, with the time left', async () => {
    const s = Store.open(file);
    const e = makeEngine(s);
    await e.start();
    must(await e.block('youtube', UID));
    const c = pendingOf(await e.requestUnblock('youtube', UID));
    advance(4 * MINUTE);
    const r = await restart(s);
    const [p] = r.engine.listPending();
    expect(p).toMatchObject({ id: c.id, phase: 'cooldown', cooldownEndsAt: c.cooldownEndsAt });
    expect(await r.engine.challengeFor(c.id)).toMatchObject({
      ok: false,
      code: 'cooldown_active',
      message: expect.stringContaining('6m'),
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    advance(6 * MINUTE);
    const ch = must(await r.engine.challengeFor(c.id));
    advance(6 * SECOND);
    expect(must(await r.engine.answer(c.id, solve(ch.challenge), UID))).toMatchObject({
      result: 'applied',
    });
    expect(hosts()).toBe(HOSTS_BASE);
    r.store.close();
    store = Store.open(':memory:'); // for the shared afterEach
  });

  it('keeps an issued challenge, its attempts and its answer across a restart', async () => {
    const s = Store.open(file);
    const e = makeEngine(s);
    await e.start();
    must(await e.block('youtube', UID));
    const c = pendingOf(await e.requestUnblock('youtube', UID));
    advance(10 * MINUTE);
    const ch = must(await e.challengeFor(c.id));
    advance(10 * SECOND);
    must(await e.answer(c.id, 'wrong', UID));
    const r = await restart(s);
    expect(r.engine.listPending()[0]).toMatchObject({ challengeIssued: true, attemptsLeft: 2 });
    const same = must(await r.engine.challengeFor(c.id));
    expect(same.challenge).toEqual(ch.challenge);
    expect(must(await r.engine.answer(c.id, solve(same.challenge), UID))).toMatchObject({
      result: 'applied',
    });
    r.store.close();
    store = Store.open(':memory:');
  });

  it('keeps rules, schedules, limits, settings, passes and the event log', async () => {
    const s = Store.open(file);
    const e = makeEngine(s);
    await e.start();
    must(await e.block('youtube', UID));
    appliedOf(await e.requestLimit('youtube', 25, UID));
    appliedOf(await e.requestSetting('cooldown', '20', UID));
    await takePassOn(e, 'youtube');
    const r = await restart(s);
    expect(r.engine.list().rules[0]).toMatchObject({
      target: 'youtube',
      dailyLimitMinutes: 25,
      blockingNow: false,
    });
    expect(r.engine.settings().cooldownSeconds).toBe(1200);
    expect(r.engine.status().passesUsedToday).toBe(1);
    expect(r.store.countEvents('daemon_start')).toBe(2);
    expect(r.store.countEvents('pass_started')).toBe(1);
    r.store.close();
    store = Store.open(':memory:');
  });

  async function takePassOn(e: Engine, target: string) {
    const c = pendingOf(await e.requestPass(target, UID));
    const ch = must(await e.challengeFor(c.id));
    advance(6 * SECOND);
    must(await e.answer(c.id, solve(ch.challenge), UID));
  }
});

describe('clock changes are noticed', () => {
  it('records a clock_jump when wall time moves without the boot clock', async () => {
    clock.advance(3600_000); // someone sets the clock forward an hour
    boot.advance(5000);
    await engine.verify();
    expect(kinds('clock_jump')).toMatchObject([
      { payload: { wallDeltaMs: 3600_000, bootDeltaMs: 5000 } },
    ]);
  });

  it('is quiet for normal time passing, including a long suspend (both clocks advance)', async () => {
    await tick(5000);
    await tick(8 * 3600_000);
    expect(kinds('clock_jump')).toEqual([]);
  });
});

describe('enforcement basics still hold', () => {
  it('reverts a hand edit and records tampering', async () => {
    must(await engine.block('youtube', UID));
    fs.writeFileSync(sb.hosts, HOSTS_BASE);
    await engine.verify();
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(kinds('tamper')).toMatchObject([{ payload: { kind: 'removed', restored: true } }]);
  });

  it('a second block of the same rule changes nothing', async () => {
    must(await engine.block('youtube', UID));
    expect(must(await engine.block('youtube', UID)).added).toBe(false);
    expect(kinds('rule_added')).toHaveLength(1);
  });

  it('dry run computes everything but writes nothing', async () => {
    const dry = makeEngine(Store.open(':memory:'), { dryRun: true });
    await dry.start();
    const r = must(await dry.block('youtube', UID));
    expect(r.blockedDomainCount).toBe(ytDomains().length);
    expect(hosts()).toBe(HOSTS_BASE);
  });

  it('serialises concurrent operations', async () => {
    await Promise.all([
      engine.block('a.example', UID),
      engine.block('b.example', UID),
      engine.verify(),
      engine.block('c.example', UID),
    ]);
    expect(engine.list().rules).toHaveLength(3);
    expect(hosts()).toBe(HOSTS_BASE + renderBlock(engine.desiredDomains()));
    expect(store.countEvents('tamper')).toBe(0);
  });
});
