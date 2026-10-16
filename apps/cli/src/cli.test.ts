import { describe, expect, it } from 'vitest';
import {
  IpcClientError,
  type DataOf,
  type Op,
  type PublicChallengeWire,
  type Response,
} from '@hourkeep/ipc';
import { DEFAULT_SOCKET, runCli, type CliIo } from './cli.js';

const NOW = Date.parse('2026-10-14T10:00:10.000Z');
const MIN = 60_000;

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  calls: { socket: string; op: string; params: unknown }[];
  sleeps: number[];
  prompts: string[];
}

interface Opts {
  env?: NodeJS.ProcessEnv;
  answers?: (string | null)[];
  interactive?: boolean;
}

function harness(reply: (op: Op, params: unknown, n: number) => unknown, o: Opts = {}): Harness {
  const h: Harness = {
    out: [],
    err: [],
    calls: [],
    sleeps: [],
    prompts: [],
    io: undefined as unknown as CliIo,
  };
  const answers = [...(o.answers ?? [])];
  let n = 0;
  h.io = {
    call: (async (socket: string, op: Op, params: unknown) => {
      h.calls.push({ socket, op, params });
      const r = reply(op, params, n++);
      if (r instanceof Error) throw r;
      return r as Response<Op>;
    }) as CliIo['call'],
    stdout: (t) => h.out.push(t),
    stderr: (t) => h.err.push(t),
    now: () => NOW,
    env: o.env ?? {},
    prompt: async (q) => {
      h.prompts.push(q);
      return answers.length > 0 ? (answers.shift() as string | null) : null;
    },
    sleep: async (ms) => void h.sleeps.push(ms),
    isInteractive: o.interactive ?? false,
  };
  return h;
}

const ok = <T>(data: T) => ({ v: 3, id: 'x', ok: true, data });
const fail = (code: string, message: string) => ({
  v: 2,
  id: 'x',
  ok: false,
  error: { code, message },
});
const text = (a: string[]) => a.join('');

const statusData: DataOf<'status'> = {
  daemonVersion: '0.1.0-dev',
  protocol: 3,
  dryRun: false,
  ruleCount: 1,
  blockedDomainCount: 25,
  lastReconcileAt: NOW - 3000,
  tamperCount: 2,
  lastTamperAt: NOW - 3600_000,
  pendingCount: 1,
  passesUsedToday: 1,
  passesPerDay: 3,
  dns: {
    enabled: true,
    listening: '127.0.0.1:53',
    strategy: 'systemd-resolved',
    inEffect: true,
    upstreamCount: 2,
    problem: null,
    blockedToday: 1234,
  },
  callerUid: 1000,
};

const view = (over: Partial<DataOf<'pending_list'>['changes'][number]> = {}) => ({
  id: 3,
  kind: 'remove_rule' as const,
  summary: 'stop blocking youtube',
  requestedAt: NOW,
  requestedByUid: 1000,
  cooldownEndsAt: NOW + 10 * MIN,
  expiresAt: NOW + 40 * MIN,
  phase: 'cooldown' as const,
  challengeIssued: false,
  attemptsLeft: 3,
  ...over,
});
const typing = {
  id: 'abcd1234',
  issuedAt: NOW,
  earliestAnswerAt: NOW + 5000,
  instructions: 'Type this exactly to stop blocking youtube:',
  data: { kind: 'typing' as const, text: 'abcdef-ghjkmn-pqrstu-vwxyz2-345678-abcdef' },
};

describe('read-only commands', () => {
  it('status shows pending changes and passes', async () => {
    const h = harness(() => ok(statusData));
    expect(await runCli(['status'], h.io)).toBe(0);
    const t = text(h.out);
    expect(t).toContain('hourkeepd 0.1.0-dev (protocol 3)');
    expect(t).toContain('Pending changes:   1  (see: hourkeep pending)');
    expect(t).toContain('Passes today:      1 of 3 used');
    expect(t).toContain(
      'DNS layer:         on (127.0.0.1:53, systemd-resolved, 2 upstreams), in effect',
    );
    expect(t).toContain('Blocked today:     1,234 lookups');
    expect(t).toContain('Last check:        2026-10-14T10:00:07.000Z (3s ago)');
    expect(t).toContain('Tamper events:     2, last 2026-10-14T09:00:10.000Z (1h ago)');
    expect(h.calls).toEqual([{ socket: DEFAULT_SOCKET, op: 'status', params: {} }]);
  });

  it('list shows schedule, limit and state per rule', async () => {
    const rule = (over = {}) => ({
      kind: 'group' as const,
      target: 'youtube',
      createdAt: 1,
      schedule: null,
      scheduleText: 'always',
      dailyLimitMinutes: null,
      blockingNow: true,
      passEndsAt: null,
      ...over,
    });
    const h = harness(() =>
      ok({
        rules: [
          rule(),
          rule({
            target: 'reddit.com',
            kind: 'domain',
            scheduleText: 'mon-fri 09:00-17:00 (UTC)',
            dailyLimitMinutes: 30,
            blockingNow: false,
          }),
          rule({ target: 'x.com', kind: 'domain', blockingNow: false, passEndsAt: NOW + 5 * MIN }),
        ],
        groups: [{ id: 'youtube', name: 'YouTube', domainCount: 25 }],
        blockedDomains: new Array(25).fill('d'),
      }),
    );
    await runCli(['list'], h.io);
    const t = text(h.out);
    expect(t).toMatch(/youtube {2}\(group\) {2}blocking now/);
    expect(t).toContain('schedule: mon-fri 09:00-17:00 (UTC)');
    expect(t).toContain('daily limit: 30 pass minutes');
    expect(t).toContain('daily limit: none');
    expect(t).toContain('not blocking now (outside its schedule)');
    expect(t).toContain('pass running, 5m left');
    expect(t).toContain('25 domains blocked right now.');
    expect(t).toMatch(/Available groups:\n\s+youtube\s+YouTube, 25 domains/);
  });

  it('list hints at blocking something when empty', async () => {
    const h = harness(() => ok({ rules: [], groups: [], blockedDomains: [] }));
    await runCli(['list'], h.io);
    expect(text(h.out)).toContain('No rules. Block something with: hourkeep block');
  });

  it('settings prints the four settings', async () => {
    const h = harness(() =>
      ok({ cooldownSeconds: 600, passesPerDay: 3, passMinutes: 15, timezone: 'Asia/Kolkata' }),
    );
    await runCli(['settings'], h.io);
    expect(text(h.out)).toBe(
      'cooldown:        10 minutes\npasses-per-day:  3\npass-minutes:    15\ntimezone:        Asia/Kolkata\n',
    );
    expect(h.calls[0]?.op).toBe('settings_get');
  });

  it('pending lists changes with time left, or says there are none', async () => {
    const h = harness(() =>
      ok({
        changes: [
          view(),
          view({
            id: 4,
            phase: 'ready',
            challengeIssued: true,
            attemptsLeft: 2,
            summary: 'use a temporary pass on x.com',
          }),
        ],
      }),
    );
    await runCli(['pending'], h.io);
    const t = text(h.out);
    expect(t).toContain('#3  stop blocking youtube');
    expect(t).toContain('cooldown: 10m left');
    expect(t).toContain('#4  use a temporary pass on x.com');
    expect(t).toContain('challenge issued, 2 attempts left');
    expect(t).toContain('hourkeep confirm <id>');
    const none = harness(() => ok({ changes: [] }));
    await runCli(['pending', 'list'], none.io);
    expect(text(none.out)).toBe('No pending changes.\n');
  });
});

describe('status shows the DNS layer honestly', () => {
  const dnsOf = (dns: Partial<DataOf<'status'>['dns']>) =>
    harness(() => ok({ ...statusData, dns: { ...statusData.dns, ...dns } }));
  const line = async (dns: Partial<DataOf<'status'>['dns']>) => {
    const h = dnsOf(dns);
    await runCli(['status'], h.io);
    return text(h.out);
  };

  it('says it is off, and how to turn it on', async () => {
    const t = await line({
      enabled: false,
      listening: null,
      strategy: null,
      inEffect: null,
      upstreamCount: 0,
      blockedToday: 0,
    });
    expect(t).toContain('DNS layer:         off (start hourkeepd with --dns');
    expect(t).not.toContain('Blocked today');
  });

  it('says when it is on but not running, with the reason', async () => {
    const t = await line({
      listening: null,
      inEffect: null,
      problem: 'no usable upstream DNS server found, so the system resolver was left alone',
    });
    expect(t).toContain('on, but NOT running: no usable upstream DNS server found');
  });

  it('says when it is configured but programs do not reach it', async () => {
    const t = await line({ inEffect: false, problem: 'something else has priority' });
    expect(t).toContain(
      'configured (127.0.0.1:53, systemd-resolved, 2 upstreams) but NOT in effect',
    );
    expect(t).toContain('something else has priority');
  });

  it('uses the singular for one upstream', async () => {
    expect(await line({ upstreamCount: 1 })).toContain('1 upstream)');
  });
});

describe('changes that tighten or loosen', () => {
  const block = (kind: 'group' | 'domain', added: boolean) =>
    ok({ rule: { kind, target: 'youtube', createdAt: 1 }, added, blockedDomainCount: 25 });

  it('block sends the target verbatim; groups get the limits note', async () => {
    const h = harness(() => block('group', true));
    expect(await runCli(['block', 'YouTube'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ op: 'block', params: { target: 'YouTube' } });
    expect(text(h.out)).toContain('Blocked youtube (group). 25 domains are blocked right now.');
    expect(text(h.out)).toContain('DNS-over-HTTPS');
  });

  it('block of a domain omits the note and reports repeats', async () => {
    const h = harness(() => block('domain', false));
    await runCli(['block', 'youtube.com'], h.io);
    expect(text(h.out)).toContain('was already blocked');
    expect(text(h.out)).not.toContain('DNS-over-HTTPS');
  });

  it('unblock explains that nothing happened yet and how to continue or cancel', async () => {
    const h = harness(() => ok({ status: 'pending', change: view() }));
    expect(await runCli(['unblock', 'youtube'], h.io)).toBe(0);
    const t = text(h.out);
    expect(t).toContain('This loosens protection, so it does not happen yet.');
    expect(t).toContain('#3  stop blocking youtube');
    expect(t).toContain('Wait 10m, then run: hourkeep confirm 3   (or: hourkeep confirm 3 --wait)');
    expect(t).toContain('hourkeep pending cancel 3');
  });

  it('a ready pending change says to confirm now', async () => {
    const h = harness(() => ok({ status: 'pending', change: view({ phase: 'ready' }) }));
    await runCli(['unblock', 'youtube'], h.io);
    expect(text(h.out)).toContain('It is ready now. Run: hourkeep confirm 3');
  });

  it('applied and no-op outcomes print the daemon message', async () => {
    const a = harness(() =>
      ok({ status: 'applied', message: 'Daily limit of youtube is now 20 minutes.' }),
    );
    await runCli(['limit', 'set', 'youtube', '20'], a.io);
    expect(text(a.out)).toBe('Daily limit of youtube is now 20 minutes.\n');
    expect(a.calls[0]).toMatchObject({
      op: 'limit_set',
      params: { target: 'youtube', minutes: 20 },
    });
    const n = harness(() => ok({ status: 'noop', message: 'Nothing to change.' }));
    await runCli(['settings', 'set', 'cooldown', '10'], n.io);
    expect(n.calls[0]).toMatchObject({
      op: 'settings_set',
      params: { key: 'cooldown', value: '10' },
    });
    expect(text(n.out)).toBe('Nothing to change.\n');
  });

  it('limit set accepts 0, limit clear sends null, bad minutes are a usage error', async () => {
    const zero = harness(() => ok({ status: 'applied', message: 'ok' }));
    await runCli(['limit', 'set', 'youtube', '0'], zero.io);
    expect(zero.calls[0]?.params).toEqual({ target: 'youtube', minutes: 0 });
    const clear = harness(() => ok({ status: 'pending', change: view({ kind: 'set_limit' }) }));
    await runCli(['limit', 'clear', 'youtube'], clear.io);
    expect(clear.calls[0]?.params).toEqual({ target: 'youtube', minutes: null });
    const bad = harness(() => ok({}));
    expect(await runCli(['limit', 'set', 'youtube', 'many'], bad.io)).toBe(2);
    expect(await runCli(['limit', 'set', 'youtube', '-5'], bad.io)).toBe(2);
    expect(bad.calls).toEqual([]);
  });

  it('pass end and schedule clear send their operations', async () => {
    const h = harness(() => ok({ status: 'applied', message: 'done' }));
    await runCli(['pass', 'end', 'youtube'], h.io);
    await runCli(['schedule', 'clear', 'youtube'], h.io);
    expect(h.calls.map((c) => c.op)).toEqual(['pass_end', 'schedule_clear']);
  });

  it('pending cancel validates the id', async () => {
    const h = harness(() => ok({ message: 'Cancelled #3: stop blocking youtube.' }));
    expect(await runCli(['pending', 'cancel', '3'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ op: 'pending_cancel', params: { changeId: 3 } });
    expect(text(h.out)).toContain('Cancelled #3');
    expect(await runCli(['pending', 'cancel', 'three'], h.io)).toBe(2);
  });
});

describe('schedule set', () => {
  it('parses windows locally, asks the daemon for its timezone, and sends a structured schedule', async () => {
    const h = harness((op) =>
      op === 'settings_get'
        ? ok({ cooldownSeconds: 600, passesPerDay: 3, passMinutes: 15, timezone: 'Asia/Kolkata' })
        : ok({ status: 'applied', message: 'Schedule set.' }),
    );
    expect(
      await runCli(['schedule', 'set', 'youtube', 'mon-fri 09:00-17:00', 'sat 10:00-12:00'], h.io),
    ).toBe(0);
    expect(h.calls.map((c) => c.op)).toEqual(['settings_get', 'schedule_set']);
    const sent = h.calls[1]?.params as {
      target: string;
      schedule: { timezone: string; days: Record<string, unknown[]> };
    };
    expect(sent.target).toBe('youtube');
    expect(sent.schedule.timezone).toBe('Asia/Kolkata');
    expect(sent.schedule.days['mon']).toEqual([{ start: 540, end: 1020 }]);
    expect(sent.schedule.days['sat']).toEqual([{ start: 600, end: 720 }]);
    expect(sent.schedule.days['sun']).toEqual([]);
  });

  it('--tz skips the settings lookup', async () => {
    const h = harness(() => ok({ status: 'applied', message: 'ok' }));
    await runCli(
      ['schedule', 'set', 'youtube', 'daily 22:00-02:00', '--tz', 'Europe/Berlin'],
      h.io,
    );
    expect(h.calls.map((c) => c.op)).toEqual(['schedule_set']);
    const sent = h.calls[0]?.params as {
      schedule: { timezone: string; days: Record<string, unknown[]> };
    };
    expect(sent.schedule.timezone).toBe('Europe/Berlin');
    expect(sent.schedule.days['sat']).toEqual(
      [
        { start: 1320, end: 1440 },
        { start: 0, end: 120 },
      ].sort((a, b) => a.start - b.start),
    );
  });

  it('rejects a bad window before talking to the daemon', async () => {
    const h = harness(() => ok({}));
    expect(await runCli(['schedule', 'set', 'youtube', 'someday 9-10', '--tz', 'UTC'], h.io)).toBe(
      1,
    );
    expect(h.calls).toEqual([]);
    expect(text(h.err)).toContain('cannot read "someday 9-10"');
    const j = harness(() => ok({}));
    expect(
      await runCli(
        ['--json', 'schedule', 'set', 'youtube', 'mon 25:00-26:00', '--tz', 'UTC'],
        j.io,
      ),
    ).toBe(1);
    expect(JSON.parse(text(j.out))).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
  });

  it('rejects an unknown timezone', async () => {
    const h = harness(() => ok({}));
    expect(
      await runCli(['schedule', 'set', 'youtube', 'mon 09:00-10:00', '--tz', 'Mars/Base'], h.io),
    ).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it('shows a pending outcome when the schedule loosens protection', async () => {
    const h = harness(() =>
      ok({
        status: 'pending',
        change: view({
          kind: 'set_schedule',
          summary: 'change the schedule of youtube to mon 09:00-10:00 (UTC)',
        }),
      }),
    );
    await runCli(['schedule', 'set', 'youtube', 'mon 09:00-10:00', '--tz', 'UTC'], h.io);
    expect(text(h.out)).toContain('change the schedule of youtube');
  });
});

describe('confirm', () => {
  const challengeReply = (c: PublicChallengeWire = typing) => ok({ challenge: c, attemptsLeft: 3 });
  const applied = ok({ result: 'applied', message: 'Stopped blocking youtube.' });

  it('picks the only pending change, shows the challenge, prompts, and applies', async () => {
    const h = harness(
      (op) => {
        if (op === 'pending_list') return ok({ changes: [view({ phase: 'ready' })] });
        if (op === 'pending_challenge') return challengeReply();
        return applied;
      },
      { interactive: true, answers: [typing.data.text] },
    );
    expect(await runCli(['confirm'], h.io)).toBe(0);
    expect(h.calls.map((c) => c.op)).toEqual([
      'pending_list',
      'pending_challenge',
      'pending_answer',
    ]);
    expect(h.calls[2]?.params).toEqual({ changeId: 3, response: typing.data.text });
    const t = text(h.out);
    expect(t).toContain('Type this exactly to stop blocking youtube:');
    expect(t).toContain(typing.data.text);
    expect(t).toContain('Stopped blocking youtube.');
    expect(h.prompts).toEqual(['> ']);
  });

  it('shows arithmetic problems numbered and a reflection question', async () => {
    const arithmetic = {
      ...typing,
      data: { kind: 'arithmetic' as const, problems: ['12 × 3 + 10', '100 + 200 − 11'] },
    };
    const a = harness((op) => (op === 'pending_challenge' ? challengeReply(arithmetic) : applied), {
      interactive: true,
      answers: ['46 289'],
    });
    await runCli(['confirm', '3'], a.io);
    expect(text(a.out)).toContain('1) 12 × 3 + 10');
    expect(text(a.out)).toContain('2) 100 + 200 − 11');
    const reflection = {
      ...typing,
      data: {
        kind: 'reflection' as const,
        question: 'Why do you want to stop blocking youtube?',
        minWords: 8,
        minChars: 40,
      },
    };
    const r = harness((op) => (op === 'pending_challenge' ? challengeReply(reflection) : applied), {
      interactive: true,
      answers: ['because I need it for a lecture tomorrow morning'],
    });
    await runCli(['confirm', '3'], r.io);
    expect(text(r.out)).toContain('Why do you want to stop blocking youtube?');
  });

  it('with several pending changes it lists them and asks which', async () => {
    const h = harness(() => ok({ changes: [view(), view({ id: 4 })] }), { interactive: true });
    expect(await runCli(['confirm'], h.io)).toBe(1);
    expect(text(h.out)).toContain('#4');
    expect(text(h.err)).toContain('say which');
  });

  it('with nothing pending it says so', async () => {
    const h = harness(() => ok({ changes: [] }), { interactive: true });
    expect(await runCli(['confirm'], h.io)).toBe(1);
    expect(text(h.out)).toContain('No pending changes.');
  });

  it('during the cooldown it stops and says how to wait', async () => {
    const h = harness(() => fail('cooldown_active', '#3 is in its cooldown for another 9m 59s'), {
      interactive: true,
    });
    expect(await runCli(['confirm', '3'], h.io)).toBe(1);
    expect(text(h.err)).toContain('in its cooldown for another 9m 59s');
    expect(text(h.err)).toContain('hourkeep confirm 3 --wait');
    expect(h.prompts).toEqual([]);
  });

  it('--wait sleeps until the cooldown ends and then continues', async () => {
    let challenged = 0;
    const h = harness(
      (op) => {
        if (op === 'pending_challenge')
          return challenged++ === 0 ? fail('cooldown_active', 'in cooldown') : challengeReply();
        if (op === 'pending_list') return ok({ changes: [view()] });
        return applied;
      },
      { interactive: true, answers: [typing.data.text] },
    );
    expect(await runCli(['confirm', '3', '--wait'], h.io)).toBe(0);
    expect(h.sleeps).toEqual([10 * MIN + 500]);
    expect(text(h.out)).toContain('Waiting 10m for the cooldown');
    expect(text(h.out)).toContain('Stopped blocking youtube.');
  });

  it('a wrong answer shows the hint and re-prompts; a fresh challenge is shown when attempts run out', async () => {
    const fresh = {
      ...typing,
      id: 'ffff0000',
      data: { kind: 'typing' as const, text: 'zzzzzz-yyyyyy-xxxxxx-wwwwww-vvvvvv-uuuuuu' },
    };
    const replies = [
      ok({
        result: 'wrong',
        hint: 'The text did not match exactly.',
        attemptsLeft: 2,
        newChallenge: null,
      }),
      ok({
        result: 'wrong',
        hint: 'The text did not match exactly.',
        attemptsLeft: 3,
        newChallenge: fresh,
      }),
      applied,
    ];
    const h = harness(
      (op) => (op === 'pending_challenge' ? challengeReply() : (replies.shift() as unknown)),
      {
        interactive: true,
        answers: ['bad one', 'bad two', fresh.data.text],
      },
    );
    expect(await runCli(['confirm', '3'], h.io)).toBe(0);
    const t = text(h.out);
    expect(t).toContain('Not quite: The text did not match exactly. (2 attempts left)');
    expect(t).toContain('Too many wrong answers. Here is a new challenge.');
    expect(t).toContain(fresh.data.text);
    expect(h.prompts).toHaveLength(3);
  });

  it('holds an answer that was too quick and sends it again after the minimum time', async () => {
    let n = 0;
    const h = harness(
      (op) => {
        if (op === 'pending_challenge') return challengeReply();
        return n++ === 0 ? fail('too_early', 'wait 4s before answering') : applied;
      },
      { interactive: true, answers: [typing.data.text] },
    );
    expect(await runCli(['confirm', '3'], h.io)).toBe(0);
    expect(h.sleeps).toEqual([5000 + 250]);
    expect(h.calls.filter((c) => c.op === 'pending_answer')).toHaveLength(2);
    expect(h.prompts).toHaveLength(1);
    expect(text(h.out)).toContain('Too quick');
  });

  it('stops when input ends without an answer', async () => {
    const h = harness((op) => (op === 'pending_challenge' ? challengeReply() : applied), {
      interactive: true,
      answers: [],
    });
    expect(await runCli(['confirm', '3'], h.io)).toBe(1);
    expect(text(h.err)).toContain('no answer given');
  });

  it('outside a terminal it prints the challenge and how to answer by flag', async () => {
    const h = harness(() => challengeReply(), { interactive: false });
    expect(await runCli(['confirm', '3'], h.io)).toBe(1);
    expect(text(h.out)).toContain(typing.data.text);
    expect(text(h.err)).toContain('--answer');
    expect(h.prompts).toEqual([]);
  });

  it('--answer submits once without prompting', async () => {
    const h = harness(() => applied, { interactive: false });
    expect(await runCli(['confirm', '3', '--answer', 'my answer'], h.io)).toBe(0);
    expect(h.calls).toEqual([
      {
        socket: DEFAULT_SOCKET,
        op: 'pending_answer',
        params: { changeId: 3, response: 'my answer' },
      },
    ]);
    const wrong = harness(() =>
      ok({ result: 'wrong', hint: 'nope', attemptsLeft: 2, newChallenge: null }),
    );
    expect(await runCli(['confirm', '3', '--answer', 'x'], wrong.io)).toBe(1);
    expect(text(wrong.out)).toContain('Wrong: nope');
  });

  it('--json without --answer prints the challenge for a script to solve', async () => {
    const h = harness(() => challengeReply());
    expect(await runCli(['--json', 'confirm', '3'], h.io)).toBe(0);
    expect(JSON.parse(text(h.out))).toEqual({
      ok: true,
      data: { challenge: typing, attemptsLeft: 3 },
    });
  });

  it('--json reports errors with their code', async () => {
    const h = harness(() => fail('cooldown_active', 'still waiting'));
    expect(await runCli(['--json', 'confirm', '3'], h.io)).toBe(1);
    expect(JSON.parse(text(h.out))).toEqual({
      ok: false,
      error: { code: 'cooldown_active', message: 'still waiting' },
    });
  });

  it('expired changes are reported', async () => {
    const h = harness(() => fail('expired', '#3 expired. Request the change again.'), {
      interactive: true,
    });
    expect(await runCli(['confirm', '3'], h.io)).toBe(1);
    expect(text(h.err)).toContain('expired');
  });

  it('validates the id', async () => {
    const h = harness(() => ok({}));
    expect(await runCli(['confirm', 'abc'], h.io)).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe('pass start', () => {
  const pending = ok({
    status: 'pending',
    change: view({
      id: 9,
      kind: 'start_pass',
      summary: 'use a temporary pass on youtube',
      phase: 'ready',
      cooldownEndsAt: NOW,
    }),
  });

  it('at a terminal it requests the pass and goes straight into the challenge', async () => {
    const h = harness(
      (op) => {
        if (op === 'pass_start') return pending;
        if (op === 'pending_challenge') return ok({ challenge: typing, attemptsLeft: 3 });
        return ok({ result: 'applied', message: 'Pass started on youtube for 15m.' });
      },
      { interactive: true, answers: [typing.data.text] },
    );
    expect(await runCli(['pass', 'start', 'youtube'], h.io)).toBe(0);
    expect(h.calls.map((c) => c.op)).toEqual(['pass_start', 'pending_challenge', 'pending_answer']);
    expect(h.calls[1]?.params).toEqual({ changeId: 9 });
    expect(text(h.out)).toContain('Pass started on youtube for 15m.');
  });

  it('without a terminal, or with --no-confirm, it only requests', async () => {
    const a = harness(() => pending, { interactive: false });
    await runCli(['pass', 'start', 'youtube'], a.io);
    expect(a.calls.map((c) => c.op)).toEqual(['pass_start']);
    expect(text(a.out)).toContain('hourkeep confirm 9');
    const b = harness(() => pending, { interactive: true });
    await runCli(['pass', 'start', 'youtube', '--no-confirm'], b.io);
    expect(b.calls.map((c) => c.op)).toEqual(['pass_start']);
  });

  it('shows why a pass is refused', async () => {
    const h = harness(() => fail('limit_reached', 'you have used all 3 passes for today'), {
      interactive: true,
    });
    expect(await runCli(['pass', 'start', 'youtube'], h.io)).toBe(1);
    expect(text(h.err)).toBe('hourkeep: you have used all 3 passes for today\n');
  });

  it('a no-op (already running, or not blocking) is not an error', async () => {
    const h = harness(
      () => ok({ status: 'noop', message: 'A pass on youtube is already running.' }),
      { interactive: true },
    );
    expect(await runCli(['pass', 'start', 'youtube'], h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
  });
});

describe('global options and errors', () => {
  it('--json prints data for success, in either position', async () => {
    const h = harness(() => ok(statusData));
    expect(await runCli(['--json', 'status'], h.io)).toBe(0);
    expect(JSON.parse(text(h.out))).toEqual({ ok: true, data: statusData });
    const after = harness(() => ok(statusData));
    await runCli(['status', '--json'], after.io);
    expect(JSON.parse(text(after.out))).toEqual({ ok: true, data: statusData });
  });

  it('--json prints a pending outcome as data, not prose', async () => {
    const h = harness(() => ok({ status: 'pending', change: view() }));
    await runCli(['unblock', 'youtube', '--json'], h.io);
    expect(JSON.parse(text(h.out))).toMatchObject({
      ok: true,
      data: { status: 'pending', change: { id: 3 } },
    });
  });

  it('--socket beats HOURKEEP_SOCKET beats the default', async () => {
    const env = { HOURKEEP_SOCKET: '/tmp/env.sock' };
    const a = harness(() => ok(statusData), { env });
    await runCli(['status'], a.io);
    expect(a.calls[0]?.socket).toBe('/tmp/env.sock');
    const b = harness(() => ok(statusData), { env });
    await runCli(['status', '--socket', '/tmp/flag.sock'], b.io);
    expect(b.calls[0]?.socket).toBe('/tmp/flag.sock');
  });

  it('daemon refusals go to stderr with exit code 1', async () => {
    const h = harness(() => fail('invalid_target', 'wildcards are not supported'));
    expect(await runCli(['block', '*.x.com'], h.io)).toBe(1);
    expect(text(h.err)).toBe('hourkeep: wildcards are not supported\n');
    expect(text(h.out)).toBe('');
  });

  it('connection problems are explained, and are JSON in --json mode', async () => {
    const h = harness(
      () =>
        new IpcClientError('not-running', 'cannot reach hourkeepd at /x. Is the service running?'),
    );
    expect(await runCli(['status'], h.io)).toBe(1);
    expect(text(h.err)).toContain('Is the service running?');
    const j = harness(() => new IpcClientError('permission', 'permission denied'));
    expect(await runCli(['status', '--json'], j.io)).toBe(1);
    expect(JSON.parse(text(j.out))).toMatchObject({ ok: false, error: { code: 'client' } });
  });

  it.each([
    [['frobnicate']],
    [['block']],
    [['status', '--nope']],
    [['schedule', 'set', 'youtube']],
    [['pass']],
  ])('returns 2 for bad usage %j', async (argv) => {
    const h = harness(() => ok(statusData));
    expect(await runCli(argv, h.io)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('prints help and version with exit code 0', async () => {
    const h = harness(() => ok(statusData));
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(text(h.out)).toMatch(
      /status[\s\S]*list[\s\S]*block[\s\S]*unblock[\s\S]*schedule[\s\S]*limit[\s\S]*pass[\s\S]*pending[\s\S]*confirm[\s\S]*settings/,
    );
    const v = harness(() => ok(statusData));
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(text(v.out)).toContain('0.3.0-dev');
  });
});
