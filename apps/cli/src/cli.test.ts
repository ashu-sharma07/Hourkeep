import { describe, expect, it } from 'vitest';
import { IpcClientError, type DataOf, type Op, type Response } from '@hourkeep/ipc';
import { DEFAULT_SOCKET, runCli, type CliIo } from './cli.js';

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  calls: { socket: string; op: string; params: unknown }[];
}

function harness(
  reply: (op: Op, params: unknown) => unknown,
  env: NodeJS.ProcessEnv = {},
): Harness {
  const h: Harness = { out: [], err: [], calls: [], io: undefined as unknown as CliIo };
  h.io = {
    call: (async (socket: string, op: Op, params: unknown) => {
      h.calls.push({ socket, op, params });
      const r = reply(op, params);
      if (r instanceof Error) throw r;
      return r as Response<Op>;
    }) as CliIo['call'],
    stdout: (t) => h.out.push(t),
    stderr: (t) => h.err.push(t),
    now: () => Date.parse('2026-10-14T10:00:10.000Z'),
    env,
  };
  return h;
}

const ok = <T>(data: T) => ({ v: 1, id: 'x', ok: true, data });
const fail = (code: string, message: string) => ({
  v: 1,
  id: 'x',
  ok: false,
  error: { code, message },
});

const statusData: DataOf<'status'> = {
  daemonVersion: '0.1.0-dev',
  protocol: 1,
  dryRun: false,
  ruleCount: 1,
  blockedDomainCount: 25,
  lastReconcileAt: Date.parse('2026-10-14T10:00:07.000Z'),
  tamperCount: 2,
  lastTamperAt: Date.parse('2026-10-14T09:00:10.000Z'),
  callerUid: 1000,
};

describe('hourkeep CLI', () => {
  it('status prints a readable summary', async () => {
    const h = harness(() => ok(statusData));
    expect(await runCli(['status'], h.io)).toBe(0);
    const text = h.out.join('');
    expect(text).toContain('hourkeepd 0.1.0-dev (protocol 1)');
    expect(text).toContain('Mode:              enforcing');
    expect(text).toContain('Last check:        2026-10-14T10:00:07.000Z (3s ago)');
    expect(text).toContain('Tamper events:     2, last 2026-10-14T09:00:10.000Z (1h ago)');
    expect(text).toContain('uid 1000');
    expect(h.calls).toEqual([{ socket: DEFAULT_SOCKET, op: 'status', params: {} }]);
  });

  it('status says so in dry-run mode and with unknown uid and no checks yet', async () => {
    const h = harness(() =>
      ok({
        ...statusData,
        dryRun: true,
        callerUid: null,
        lastReconcileAt: null,
        tamperCount: 0,
        lastTamperAt: null,
      }),
    );
    await runCli(['status'], h.io);
    const text = h.out.join('');
    expect(text).toContain('dry run');
    expect(text).toContain('uid unknown');
    expect(text).toContain('Last check:        never');
    expect(text).toContain('Tamper events:     0\n');
  });

  it('block sends the target verbatim; the daemon decides if it is a group', async () => {
    const h = harness(() =>
      ok({
        rule: { kind: 'group', target: 'youtube', createdAt: 1 },
        added: true,
        blockedDomainCount: 25,
      }),
    );
    expect(await runCli(['block', 'YouTube'], h.io)).toBe(0);
    expect(h.calls[0]).toMatchObject({ op: 'block', params: { target: 'YouTube' } });
    const text = h.out.join('');
    expect(text).toContain('Blocked youtube (group). 25 domains are now blocked.');
    expect(text).toContain('DNS-over-HTTPS');
  });

  it('block of a plain domain omits the group limits note and reports repeats', async () => {
    const h = harness(() =>
      ok({
        rule: { kind: 'domain', target: 'a.example', createdAt: 1 },
        added: false,
        blockedDomainCount: 2,
      }),
    );
    await runCli(['block', 'a.example'], h.io);
    const text = h.out.join('');
    expect(text).toContain('a.example (domain) was already blocked.');
    expect(text).not.toContain('DNS-over-HTTPS');
  });

  it('unblock reports removed and not-found cases', async () => {
    const removed = harness(() =>
      ok({ rule: { kind: 'group', target: 'youtube' }, removed: true, blockedDomainCount: 0 }),
    );
    expect(await runCli(['unblock', 'youtube'], removed.io)).toBe(0);
    expect(removed.out.join('')).toContain(
      'Unblocked youtube (group). 0 domains are still blocked.',
    );

    const none = harness(() =>
      ok({ rule: { kind: 'domain', target: 'x.example' }, removed: false, blockedDomainCount: 0 }),
    );
    expect(await runCli(['unblock', 'x.example'], none.io)).toBe(0);
    expect(none.out.join('')).toContain('nothing to unblock');
  });

  it('list shows rules and groups, or a hint when empty', async () => {
    const full = harness(() =>
      ok({
        rules: [
          { kind: 'group', target: 'youtube', createdAt: Date.parse('2026-10-14T00:00:00Z') },
        ],
        groups: [{ id: 'youtube', name: 'YouTube', domainCount: 25 }],
        blockedDomains: new Array(25).fill('d'),
      }),
    );
    await runCli(['list'], full.io);
    const text = full.out.join('');
    expect(text).toMatch(/youtube\s+group\s+since 2026-10-14T00:00:00.000Z/);
    expect(text).toContain('25 domains blocked in total.');
    expect(text).toMatch(/Available groups:\n\s+youtube\s+YouTube, 25 domains/);

    const empty = harness(() => ok({ rules: [], groups: [], blockedDomains: [] }));
    await runCli(['list'], empty.io);
    expect(empty.out.join('')).toContain('No rules. Block something with: hourkeep block');
  });

  describe('--json', () => {
    it('prints the data object for success', async () => {
      const h = harness(() => ok(statusData));
      expect(await runCli(['--json', 'status'], h.io)).toBe(0);
      expect(JSON.parse(h.out.join(''))).toEqual({ ok: true, data: statusData });
    });

    it('works after the subcommand too, and prints errors as JSON with a non-zero code', async () => {
      const h = harness(() => fail('invalid_target', 'unknown group "foo"'));
      expect(await runCli(['block', 'foo', '--json'], h.io)).toBe(1);
      expect(JSON.parse(h.out.join(''))).toEqual({
        ok: false,
        error: { code: 'invalid_target', message: 'unknown group "foo"' },
      });
      expect(h.err.join('')).toBe('');
    });
  });

  describe('--socket and environment', () => {
    it('uses --socket', async () => {
      const h = harness(() => ok(statusData));
      await runCli(['--socket', '/tmp/x.sock', 'status'], h.io);
      expect(h.calls[0]?.socket).toBe('/tmp/x.sock');
    });

    it('falls back to HOURKEEP_SOCKET, and --socket wins over it', async () => {
      const env = harness(() => ok(statusData), { HOURKEEP_SOCKET: '/tmp/env.sock' });
      await runCli(['status'], env.io);
      expect(env.calls[0]?.socket).toBe('/tmp/env.sock');
      const both = harness(() => ok(statusData), { HOURKEEP_SOCKET: '/tmp/env.sock' });
      await runCli(['status', '--socket', '/tmp/flag.sock'], both.io);
      expect(both.calls[0]?.socket).toBe('/tmp/flag.sock');
    });
  });

  describe('errors', () => {
    it('shows daemon refusals on stderr with exit code 1', async () => {
      const h = harness(() => fail('invalid_target', 'wildcards are not supported'));
      expect(await runCli(['block', '*.x.com'], h.io)).toBe(1);
      expect(h.err.join('')).toBe('hourkeep: wildcards are not supported\n');
      expect(h.out.join('')).toBe('');
    });

    it('explains connection problems', async () => {
      const h = harness(
        () =>
          new IpcClientError(
            'not-running',
            'cannot reach hourkeepd at /x. Is the service running?',
          ),
      );
      expect(await runCli(['status'], h.io)).toBe(1);
      expect(h.err.join('')).toContain('Is the service running?');
    });

    it('reports connection problems as JSON in --json mode', async () => {
      const h = harness(() => new IpcClientError('permission', 'permission denied'));
      expect(await runCli(['status', '--json'], h.io)).toBe(1);
      expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: false, error: { code: 'client' } });
    });

    it.each([[['frobnicate']], [['block']], [['status', '--nope']]])(
      'returns 2 for bad usage %j',
      async (argv) => {
        const h = harness(() => ok(statusData));
        expect(await runCli(argv, h.io)).toBe(2);
        expect(h.calls).toEqual([]);
        expect(h.err.join('')).not.toBe('');
      },
    );
  });

  it('prints help and version with exit code 0', async () => {
    const h = harness(() => ok(statusData));
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out.join('')).toMatch(/status[\s\S]*list[\s\S]*block[\s\S]*unblock/);
    const v = harness(() => ok(statusData));
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(v.out.join('')).toContain('0.1.0-dev');
  });
});
