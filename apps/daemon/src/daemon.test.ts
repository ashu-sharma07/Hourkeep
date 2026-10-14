import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call } from '@hourkeep/ipc';
import { BUILTIN_GROUPS, seededRng } from '@hourkeep/core';
import { startDaemon, lookupGid, type DaemonHandle } from './daemon.js';
import type { Notifier } from './notify.js';
import {
  FakeClock,
  HOSTS_BASE,
  MINUTE,
  SECOND,
  makeSandbox,
  noopNotifier,
  silent,
  solve,
  waitFor,
  type Sandbox,
} from './test-helpers.js';

let sb: Sandbox;
let daemon: DaemonHandle | undefined;

beforeEach(() => {
  sb = makeSandbox();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  sb.cleanup();
});

const hosts = () => fs.readFileSync(sb.hosts, 'utf8');
const start = async (deps: Partial<Parameters<typeof startDaemon>[1]> = {}, cfg = sb.config) => {
  daemon = await startDaemon(cfg, { logger: silent, notifier: noopNotifier, ...deps });
  return daemon;
};
const sock = () => sb.config.socketPath;

describe('hourkeepd over its socket', () => {
  it('reports status on a fresh install', async () => {
    await start({ resolvePeer: () => ({ uid: 1234, gid: 1, pid: 1 }) });
    const r = await call(sock(), 'status', {});
    expect(r).toMatchObject({
      ok: true,
      data: {
        protocol: 2,
        dryRun: false,
        ruleCount: 0,
        blockedDomainCount: 0,
        tamperCount: 0,
        pendingCount: 0,
        passesUsedToday: 0,
        passesPerDay: 3,
        callerUid: 1234,
      },
    });
  });

  it('block youtube writes the hosts file; list shows the rule and groups', async () => {
    await start();
    const b = await call(sock(), 'block', { target: 'youtube' });
    expect(b).toMatchObject({
      ok: true,
      data: { added: true, rule: { kind: 'group', target: 'youtube' } },
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(hosts()).toContain('0.0.0.0 www.youtube.com');
    expect(hosts().startsWith(HOSTS_BASE)).toBe(true);

    const l = await call(sock(), 'list', {});
    expect(l.ok && l.data.rules.map((r) => r.target)).toEqual(['youtube']);
    expect(l.ok && l.data.rules[0]).toMatchObject({
      schedule: null,
      dailyLimitMinutes: null,
      blockingNow: true,
      passEndsAt: null,
    });
    expect(l.ok && l.data.groups).toEqual([
      { id: 'youtube', name: 'YouTube', domainCount: BUILTIN_GROUPS.groups[0]?.domains.length },
    ]);
    expect(l.ok && l.data.blockedDomains).toContain('youtu.be');
  });

  it('refuses bad targets with invalid_target', async () => {
    await start();
    const r = await call(sock(), 'block', { target: '*.googlevideo.com' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(hosts()).toBe(HOSTS_BASE);
  });

  it('unblock does not unblock: it returns a pending change and leaves the block in place', async () => {
    await start();
    await call(sock(), 'block', { target: 'youtube' });
    const r = await call(sock(), 'unblock', { target: 'youtube' });
    expect(r).toMatchObject({
      ok: true,
      data: {
        status: 'pending',
        change: { kind: 'remove_rule', phase: 'cooldown', summary: 'stop blocking youtube' },
      },
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    const p = await call(sock(), 'pending_list', {});
    expect(p.ok && p.data.changes).toHaveLength(1);
    const s = await call(sock(), 'status', {});
    expect(s.ok && s.data.pendingCount).toBe(1);
  });

  it('reverts hand edits to the managed block within the reconcile interval', async () => {
    await start();
    await call(sock(), 'block', { target: 'youtube' });
    const blocked = hosts();
    fs.writeFileSync(sb.hosts, HOSTS_BASE); // the user removes the block in a weak moment
    const t0 = Date.now();
    await waitFor(() => hosts() === blocked);
    expect(Date.now() - t0).toBeLessThan(1500);
    const s = await call(sock(), 'status', {});
    expect(s.ok && s.data.tamperCount).toBe(1);
    expect(s.ok && s.data.lastTamperAt).not.toBeNull();
  });

  it('reverts a single deleted line too', async () => {
    await start();
    await call(sock(), 'block', { target: 'youtube' });
    const blocked = hosts();
    fs.writeFileSync(sb.hosts, blocked.replace('0.0.0.0 youtube.com\n', ''));
    await waitFor(() => hosts() === blocked);
  });

  it('persists rules across a restart and re-applies them to a reset hosts file', async () => {
    await start();
    await call(sock(), 'block', { target: 'youtube' });
    await call(sock(), 'block', { target: 'example.com' });
    await daemon?.stop();
    daemon = undefined;
    fs.writeFileSync(sb.hosts, HOSTS_BASE);

    await start();
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(hosts()).toContain('0.0.0.0 www.example.com');
    const l = await call(sock(), 'list', {});
    expect(l.ok && l.data.rules.map((r) => r.target)).toEqual(['youtube', 'example.com']);
    const s = await call(sock(), 'status', {});
    expect(s.ok && s.data.tamperCount).toBe(0);
  });

  it('leaves the block in place when the daemon stops', async () => {
    await start();
    await call(sock(), 'block', { target: 'youtube' });
    await daemon?.stop();
    daemon = undefined;
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('dry run never writes the hosts file or reports it as written', async () => {
    await start({}, makeCfg({ dryRun: true }));
    const r = await call(sock(), 'block', { target: 'youtube' });
    expect(r).toMatchObject({ ok: true, data: { added: true } });
    expect(hosts()).toBe(HOSTS_BASE);
    const s = await call(sock(), 'status', {});
    expect(s.ok && s.data.dryRun).toBe(true);
  });

  it('stores the state directory privately', async () => {
    await start();
    expect(fs.statSync(sb.config.stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(sb.config.stateDir, 'hourkeep.db')).mode & 0o777).toBe(0o600);
  });

  it('leaves the socket group-accessible when the group exists', async () => {
    const groupFile = path.join(sb.dir, 'group');
    fs.writeFileSync(groupFile, `hourkeep:x:${process.getgid?.()}:me\n`);
    await start({ groupFile }, makeCfg({ socketGroup: 'hourkeep' }));
    const st = fs.statSync(sock());
    expect(st.mode & 0o777).toBe(0o660);
    expect(st.gid).toBe(process.getgid?.());
  });

  it('fails closed (root only) when the socket group does not exist', async () => {
    const groupFile = path.join(sb.dir, 'group');
    fs.writeFileSync(groupFile, 'other:x:5:\n');
    await start({ groupFile }, makeCfg({ socketGroup: 'hourkeep' }));
    expect(fs.statSync(sock()).mode & 0o777).toBe(0o600);
  });

  it('refuses to run against the real root as a non-root user', async () => {
    if (process.getuid?.() === 0) return;
    await expect(
      startDaemon({ ...sb.config, root: '/' }, { logger: silent, notifier: noopNotifier }),
    ).rejects.toThrow(/must run as root/);
  });

  it('refuses to start twice on the same socket and releases the database', async () => {
    await start();
    await expect(
      startDaemon(
        { ...sb.config, stateDir: path.join(sb.dir, 'state2') },
        { logger: silent, notifier: noopNotifier },
      ),
    ).rejects.toThrow(/already listening/);
  });

  describe('systemd integration', () => {
    it('signals ready and pings the watchdog only while the check loop is alive', async () => {
      const events: string[] = [];
      const notifier: Notifier = {
        ready: () => events.push('ready'),
        stopping: () => events.push('stopping'),
        watchdog: () => events.push('watchdog'),
        watchdogMs: 200,
      };
      await start({ notifier });
      expect(events[0]).toBe('ready');
      await waitFor(() => events.filter((e) => e === 'watchdog').length >= 2);
      await daemon?.stop();
      daemon = undefined;
      expect(events.at(-1)).toBe('stopping');
    });
  });
});

function makeCfg(over: Partial<typeof sb.config>): typeof sb.config {
  return { ...sb.config, ...over };
}

describe('the friction flow over the socket', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = new FakeClock();
  });

  const startWithClock = async () => {
    // Long interval: the tests drive time by hand, not through the timer.
    const cfg = {
      ...sb.config,
      reconcileIntervalMs: 3_600_000,
      challengeKinds: ['typing' as const, 'arithmetic' as const],
    };
    return start({ clock: clock.now, bootClock: clock.now, rng: seededRng(7) }, cfg);
  };

  it('unblock, wait out the cooldown, take the challenge, and the block is lifted', async () => {
    await startWithClock();
    await call(sock(), 'block', { target: 'youtube' });
    const u = await call(sock(), 'unblock', { target: 'youtube' });
    const id = u.ok && u.data.status === 'pending' ? u.data.change.id : -1;
    expect(id).toBeGreaterThan(0);

    // too early
    expect(await call(sock(), 'pending_challenge', { changeId: id })).toMatchObject({
      ok: false,
      error: { code: 'cooldown_active' },
    });
    expect(await call(sock(), 'pending_answer', { changeId: id, response: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'cooldown_active' },
    });

    clock.advance(10 * MINUTE);
    const c = await call(sock(), 'pending_challenge', { changeId: id });
    if (!c.ok) throw new Error(c.error.message);
    expect(c.data.attemptsLeft).toBe(3);
    expect(JSON.stringify(c.data)).not.toContain('secret');

    clock.advance(10 * SECOND);
    const wrong = await call(sock(), 'pending_answer', { changeId: id, response: 'nope' });
    expect(wrong).toMatchObject({
      ok: true,
      data: { result: 'wrong', attemptsLeft: 2, newChallenge: null },
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');

    const right = await call(sock(), 'pending_answer', {
      changeId: id,
      response: solve(c.data.challenge),
    });
    expect(right).toMatchObject({
      ok: true,
      data: { result: 'applied', message: 'Stopped blocking youtube.' },
    });
    expect(hosts()).toBe(HOSTS_BASE);
    const l = await call(sock(), 'list', {});
    expect(l.ok && l.data.rules).toEqual([]);
  });

  it('a pending change can be cancelled over the socket', async () => {
    await startWithClock();
    await call(sock(), 'block', { target: 'youtube' });
    const u = await call(sock(), 'unblock', { target: 'youtube' });
    const id = u.ok && u.data.status === 'pending' ? u.data.change.id : -1;
    expect(await call(sock(), 'pending_cancel', { changeId: id })).toMatchObject({ ok: true });
    expect(await call(sock(), 'pending_cancel', { changeId: id })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const p = await call(sock(), 'pending_list', {});
    expect(p.ok && p.data.changes).toEqual([]);
  });

  it('schedule, limit and settings operations return the right outcomes', async () => {
    await startWithClock();
    await call(sock(), 'block', { target: 'youtube' });
    const schedule = {
      timezone: 'UTC',
      days: {
        mon: [{ start: 540, end: 1020 }],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
    };
    expect(await call(sock(), 'schedule_set', { target: 'youtube', schedule })).toMatchObject({
      ok: true,
      data: { status: 'pending', change: { kind: 'set_schedule' } },
    });
    expect(await call(sock(), 'schedule_clear', { target: 'youtube' })).toMatchObject({
      ok: true,
      data: { status: 'noop' },
    });
    expect(await call(sock(), 'limit_set', { target: 'youtube', minutes: 30 })).toMatchObject({
      ok: true,
      data: { status: 'applied' },
    });
    expect(await call(sock(), 'limit_set', { target: 'youtube', minutes: null })).toMatchObject({
      ok: true,
      data: { status: 'pending', change: { kind: 'set_limit' } },
    });
    expect(await call(sock(), 'settings_get', {})).toMatchObject({
      ok: true,
      data: { cooldownSeconds: 600, passesPerDay: 3, passMinutes: 15, timezone: 'UTC' },
    });
    expect(await call(sock(), 'settings_set', { key: 'cooldown', value: '20' })).toMatchObject({
      ok: true,
      data: { status: 'applied' },
    });
    expect(await call(sock(), 'settings_set', { key: 'cooldown', value: '1' })).toMatchObject({
      ok: true,
      data: { status: 'pending' },
    });
    expect(await call(sock(), 'settings_set', { key: 'cooldown', value: 'soon' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_value' },
    });
    expect(await call(sock(), 'limit_set', { target: 'nosuch.example', minutes: 5 })).toMatchObject(
      { ok: false, error: { code: 'not_found' } },
    );
  });

  it('a pass: pending without cooldown, then the block is suspended and returns by itself', async () => {
    await startWithClock();
    await call(sock(), 'block', { target: 'youtube' });
    const p = await call(sock(), 'pass_start', { target: 'youtube' });
    const id = p.ok && p.data.status === 'pending' ? p.data.change.id : -1;
    expect(p).toMatchObject({ ok: true, data: { change: { kind: 'start_pass', phase: 'ready' } } });
    const c = await call(sock(), 'pending_challenge', { changeId: id });
    if (!c.ok) throw new Error(c.error.message);
    clock.advance(6 * SECOND);
    expect(
      await call(sock(), 'pending_answer', { changeId: id, response: solve(c.data.challenge) }),
    ).toMatchObject({ ok: true, data: { result: 'applied' } });
    expect(hosts()).toBe(HOSTS_BASE);
    const l = await call(sock(), 'list', {});
    expect(l.ok && l.data.rules[0]).toMatchObject({
      blockingNow: false,
      passEndsAt: clock.t + 15 * MINUTE - 0,
    });
    const s = await call(sock(), 'status', {});
    expect(s.ok && s.data.passesUsedToday).toBe(1);

    expect(await call(sock(), 'pass_end', { target: 'youtube' })).toMatchObject({
      ok: true,
      data: { status: 'applied' },
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('pending changes and their state survive a daemon restart', async () => {
    await startWithClock();
    await call(sock(), 'block', { target: 'youtube' });
    const u = await call(sock(), 'unblock', { target: 'youtube' });
    const id = u.ok && u.data.status === 'pending' ? u.data.change.id : -1;
    clock.advance(10 * MINUTE);
    const c1 = await call(sock(), 'pending_challenge', { changeId: id });
    await daemon?.stop();
    daemon = undefined;

    await startWithClock();
    const p = await call(sock(), 'pending_list', {});
    expect(p.ok && p.data.changes).toMatchObject([{ id, phase: 'ready', challengeIssued: true }]);
    const c2 = await call(sock(), 'pending_challenge', { changeId: id });
    expect(c1.ok && c2.ok && c2.data.challenge).toEqual(c1.ok && c1.data.challenge);
    clock.advance(6 * SECOND);
    expect(
      await call(sock(), 'pending_answer', {
        changeId: id,
        response: solve((c2.ok ? c2.data : (undefined as never)).challenge),
      }),
    ).toMatchObject({ ok: true, data: { result: 'applied' } });
    expect(hosts()).toBe(HOSTS_BASE);
  });

  it('rejects an old protocol version cleanly', async () => {
    await start();
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(sock());
      let out = '';
      s.on('data', (d) => ((out += d), s.end()));
      s.on('close', () => resolve(out));
      s.on('connect', () => s.write(JSON.stringify({ v: 1, id: 'old', op: 'status' }) + '\n'));
    });
    expect(JSON.parse(raw)).toMatchObject({
      id: 'old',
      ok: false,
      error: { code: 'unsupported_version' },
    });
  });
});

describe('lookupGid', () => {
  it('finds a group and ignores malformed lines', () => {
    const own = makeSandbox();
    const f = path.join(own.dir, 'g');
    fs.writeFileSync(f, 'root:x:0:\nbroken\nhourkeep:x:998:alice,bob\nweird:x:abc:\n');
    expect(lookupGid('hourkeep', f)).toBe(998);
    expect(lookupGid('weird', f)).toBeNull();
    expect(lookupGid('missing', f)).toBeNull();
    expect(lookupGid('x', '/nonexistent/group')).toBeNull();
    own.cleanup();
  });
});
