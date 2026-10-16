import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seededRng } from '@hourkeep/core';
import { call } from '@hourkeep/ipc';
import { DEFAULT_CONFIG, silentLogger, startDaemon, type DaemonHandle } from '@hourkeep/daemon';
import { runCli, type CliIo } from './cli.js';

// The CLI talking to a real in-process daemon over a real socket, against a fake root,
// with a clock the test moves by hand.
const MIN = 60_000;
const BASE = '127.0.0.1 localhost\n';

let dir: string;
let daemon: DaemonHandle;
let sock: string;
let hosts: string;
let now: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-'));
  fs.mkdirSync(path.join(dir, 'root/etc'), { recursive: true });
  hosts = path.join(dir, 'root/etc/hosts');
  fs.writeFileSync(hosts, BASE);
  sock = path.join(dir, 'hk.sock');
  now = Date.parse('2026-10-14T12:00:00Z'); // a Wednesday
  daemon = await startDaemon(
    {
      ...DEFAULT_CONFIG,
      root: path.join(dir, 'root'),
      socketPath: sock,
      socketGroup: null,
      stateDir: path.join(dir, 'state'),
      reconcileIntervalMs: 3_600_000,
      peercredPath: null,
      initialSettings: { ...DEFAULT_CONFIG.initialSettings, timezone: 'UTC' },
      challengeKinds: ['typing'],
    },
    {
      logger: silentLogger,
      notifier: { ready() {}, stopping() {}, watchdog() {}, watchdogMs: null },
      clock: () => now,
      bootClock: () => now,
      rng: seededRng(11),
    },
  );
});
afterEach(async () => {
  await daemon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(
  argv: string[],
  opts: { interactive?: boolean; solveFromOutput?: boolean } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const io: CliIo = {
    call: (s, op, params) => call(s, op, params),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    now: () => now,
    env: {},
    // A person reads the challenge on screen and types it back.
    prompt: async () =>
      opts.solveFromOutput ? (/[a-z2-9]{6}(?:-[a-z2-9]{6}){5}/.exec(out)?.[0] ?? '') : null,
    sleep: async (ms) => void (now += ms),
    isInteractive: opts.interactive ?? false,
  };
  return runCli(['--socket', sock, ...argv], io).then((code) => ({ code, out, err }));
}

const readHosts = () => fs.readFileSync(hosts, 'utf8');
interface Parsed {
  ok: boolean;
  data?: { challenge: { data: { text: string } }; changes: { kind: string }[] } & Record<
    string,
    unknown
  >;
  error?: { code: string };
}
const json = (r: Run): Parsed => JSON.parse(r.out) as Parsed;

/** Scripted confirm: fetch the challenge as JSON, solve it, submit the answer. */
async function confirmScripted(id: number): Promise<Run> {
  const c = json(await run(['--json', 'confirm', String(id)]));
  if (!c.ok || !c.data) throw new Error(c.error?.code);
  now += 6_000;
  return run(['confirm', String(id), '--answer', c.data.challenge.data.text]);
}

describe('hourkeep CLI against hourkeepd', () => {
  it('block, status, list', async () => {
    const b = await run(['block', 'youtube']);
    expect(b.code).toBe(0);
    expect(b.out).toContain('Blocked youtube (group)');
    expect(readHosts()).toContain('0.0.0.0 youtube.com');
    expect((await run(['list'])).out).toMatch(/youtube {2}\(group\) {2}blocking now/);
    expect(json(await run(['status', '--json'])).data).toMatchObject({
      ruleCount: 1,
      pendingCount: 0,
      passesPerDay: 3,
    });
  });

  it('status says the DNS layer is off, and stats reads the same daemon', async () => {
    await run(['block', 'youtube']);
    expect((await run(['status'])).out).toContain('DNS layer:         off');
    const r = await run(['stats', '--range', 'today']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Hourkeep stats: today (2026-10-14), times in UTC');
    expect(r.out).toContain('The DNS layer is off');
    const j = json(await run(['--json', 'stats', '--range', 'all']));
    expect(j.ok).toBe(true);
    expect(j.data).toMatchObject({
      range: 'all',
      dns: { enabled: false, blocked: 0 },
      streak: { current: 0 },
    });
  });

  it('unblock needs the cooldown and the challenge; nothing is unblocked before then', async () => {
    await run(['block', 'youtube']);
    const u = await run(['unblock', 'youtube']);
    expect(u.code).toBe(0);
    expect(u.out).toContain('This loosens protection, so it does not happen yet.');
    expect(u.out).toContain('Wait 10m');
    expect(readHosts()).toContain('0.0.0.0 youtube.com');

    const early = await run(['confirm', '1']);
    expect(early.code).toBe(1);
    expect(early.err).toContain('cooldown');
    expect(readHosts()).toContain('0.0.0.0 youtube.com');

    now += 10 * MIN;
    const done = await confirmScripted(1);
    expect(done).toMatchObject({ code: 0 });
    expect(done.out).toContain('Stopped blocking youtube.');
    expect(readHosts()).toBe(BASE);
    expect((await run(['pending'])).out).toBe('No pending changes.\n');
  });

  it('the interactive confirm prompts, holds an answer that is too quick, and applies', async () => {
    await run(['block', 'youtube']);
    await run(['unblock', 'youtube']);
    now += 10 * MIN;
    const r = await run(['confirm', '--wait'], { interactive: true, solveFromOutput: true });
    // the first prompt answer is read from the challenge on screen, so it is right at once,
    // but it arrives before the 5 second minimum, so the CLI holds it and resends
    expect(r.code).toBe(0);
    expect(r.out).toContain('Too quick');
    expect(r.out).toContain('Stopped blocking youtube.');
    expect(readHosts()).toBe(BASE);
  });

  it('--wait sleeps through the cooldown (here the fake sleep moves the clock)', async () => {
    await run(['block', 'youtube']);
    await run(['unblock', 'youtube']);
    const r = await run(['confirm', '--wait'], { interactive: true, solveFromOutput: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Waiting 10m for the cooldown');
    expect(readHosts()).toBe(BASE);
  });

  it('cancel leaves everything as it was', async () => {
    await run(['block', 'youtube']);
    await run(['unblock', 'youtube']);
    const c = await run(['pending', 'cancel', '1']);
    expect(c.out).toContain('Cancelled #1');
    expect((await run(['pending'])).out).toContain('No pending changes.');
    expect(readHosts()).toContain('0.0.0.0 youtube.com');
    now += 10 * MIN;
    expect((await run(['confirm', '1'])).code).toBe(1);
  });

  it('a schedule: shrinking coverage waits, then blocking follows the clock', async () => {
    await run(['block', 'youtube']);
    const s = await run(['schedule', 'set', 'youtube', 'mon-fri 09:00-17:00']);
    expect(s.out).toContain('does not happen yet');
    expect(readHosts()).toContain('0.0.0.0 youtube.com'); // still always-on
    now += 10 * MIN;
    expect((await confirmScripted(1)).out).toContain(
      'Schedule of youtube is now: mon-fri 09:00-17:00 (UTC)',
    );

    now = Date.parse('2026-10-14T18:00:00Z'); // after 17:00
    await daemon.engine.verify();
    expect(readHosts()).toBe(BASE);
    expect((await run(['list'])).out).toContain('not blocking now (outside its schedule)');
    now = Date.parse('2026-10-15T09:30:00Z');
    await daemon.engine.verify();
    expect(readHosts()).toContain('0.0.0.0 youtube.com');

    // widening is instant
    const w = await run(['schedule', 'set', 'youtube', 'mon-fri 08:00-18:00']);
    expect(w.out).toContain('Schedule of youtube is now');
    expect((await run(['schedule', 'clear', 'youtube'])).out).toContain('always');
  });

  it('limits: lowering is instant, raising waits', async () => {
    await run(['block', 'youtube']);
    expect((await run(['limit', 'set', 'youtube', '30'])).out).toContain('now 30 minutes');
    expect((await run(['limit', 'set', 'youtube', '20'])).out).toContain('now 20 minutes');
    expect((await run(['limit', 'set', 'youtube', '60'])).out).toContain('does not happen yet');
    expect((await run(['limit', 'clear', 'youtube'])).out).toContain('does not happen yet');
    expect((await run(['pending'])).out).toContain('set the daily limit of youtube to 60 minutes');
  });

  it('a pass: challenge only, block suspended, then ended by hand', async () => {
    await run(['block', 'youtube']);
    const p = await run(['pass', 'start', 'youtube'], { interactive: true, solveFromOutput: true });
    expect(p.code).toBe(0);
    expect(p.out).toContain('Pass started on youtube for 15m');
    expect(readHosts()).toBe(BASE);
    expect((await run(['status'])).out).toContain('Passes today:      1 of 3 used');
    expect((await run(['list'])).out).toContain('pass running');
    expect((await run(['pass', 'end', 'youtube'])).out).toContain('Blocking again');
    expect(readHosts()).toContain('0.0.0.0 youtube.com');
  });

  it('passes run out: the fourth is refused with the reason', async () => {
    await run(['block', 'youtube']);
    for (let i = 0; i < 3; i++) {
      await run(['pass', 'start', 'youtube'], { interactive: true, solveFromOutput: true });
      await run(['pass', 'end', 'youtube']);
    }
    const fourth = await run(['pass', 'start', 'youtube'], { interactive: true });
    expect(fourth.code).toBe(1);
    expect(fourth.err).toContain('all 3 passes');
  });

  it('settings: the cooldown cannot be shortened without friction', async () => {
    expect((await run(['settings', 'set', 'cooldown', '30'])).out).toContain('Updated');
    expect((await run(['settings'])).out).toContain('cooldown:        30 minutes');
    const shorten = await run(['settings', 'set', 'cooldown', '1']);
    expect(shorten.out).toContain('does not happen yet');
    expect((await run(['settings'])).out).toContain('cooldown:        30 minutes');
    expect(json(await run(['--json', 'pending'])).data?.changes[0]).toMatchObject({
      kind: 'set_setting',
    });
  });

  it('rejects bad input with the daemon message and exit code 1', async () => {
    const w = await run(['block', '*.googlevideo.com']);
    expect(w.code).toBe(1);
    expect(w.err).toContain('wildcards');
    expect((await run(['block', 'tiktok'])).err).toContain('Known groups: youtube');
    expect((await run(['unblock', 'example.com'])).err).toContain('no rule for example.com');
    expect((await run(['settings', 'set', 'cooldown', 'soon'])).err).toContain('whole number');
  });

  it('says the daemon is not running when the socket is missing', async () => {
    let err = '';
    const code = await runCli(['--socket', path.join(dir, 'missing.sock'), 'status'], {
      call: (s, op, params) => call(s, op, params),
      stdout: () => undefined,
      stderr: (t) => (err += t),
      now: Date.now,
      env: {},
      prompt: async () => null,
      sleep: async () => undefined,
      isInteractive: false,
    });
    expect(code).toBe(1);
    expect(err).toContain('Is the service running?');
  });
});
