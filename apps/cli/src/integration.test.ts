import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call } from '@hourkeep/ipc';
import { silentLogger, startDaemon, type DaemonHandle } from '@hourkeep/daemon';
import { runCli, type CliIo } from './cli.js';

// The CLI talking to a real in-process daemon over a real socket, against a fake root.
let dir: string;
let daemon: DaemonHandle;
let sock: string;
let hosts: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-'));
  fs.mkdirSync(path.join(dir, 'root/etc'), { recursive: true });
  hosts = path.join(dir, 'root/etc/hosts');
  fs.writeFileSync(hosts, '127.0.0.1 localhost\n');
  sock = path.join(dir, 'hk.sock');
  daemon = await startDaemon(
    {
      root: path.join(dir, 'root'),
      dryRun: false,
      socketPath: sock,
      socketGroup: null,
      stateDir: path.join(dir, 'state'),
      reconcileIntervalMs: 60_000,
      peercredPath: null,
    },
    {
      logger: silentLogger,
      notifier: { ready() {}, stopping() {}, watchdog() {}, watchdogMs: null },
    },
  );
});
afterEach(async () => {
  await daemon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = {
    call: (s, op, params) => call(s, op, params),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    now: Date.now,
    env: {},
  };
  return runCli(['--socket', sock, ...argv], io).then((code) => ({ code, out, err }));
}

describe('hourkeep CLI against hourkeepd', () => {
  it('block youtube, list, status, unblock', async () => {
    const b = await run(['block', 'youtube']);
    expect(b).toMatchObject({ code: 0 });
    expect(b.out).toContain('Blocked youtube (group)');
    expect(fs.readFileSync(hosts, 'utf8')).toContain('0.0.0.0 youtube.com');

    const l = await run(['list']);
    expect(l.out).toMatch(/youtube\s+group/);

    const s = await run(['status', '--json']);
    expect(JSON.parse(s.out)).toMatchObject({ ok: true, data: { ruleCount: 1, dryRun: false } });

    const u = await run(['unblock', 'youtube']);
    expect(u.out).toContain('Unblocked youtube');
    expect(fs.readFileSync(hosts, 'utf8')).toBe('127.0.0.1 localhost\n');
  });

  it('rejects a bad target with exit code 1 and a clear message', async () => {
    const r = await run(['block', '*.googlevideo.com']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('wildcards');
    const unknown = await run(['block', 'tiktok']);
    expect(unknown.err).toContain('Known groups: youtube');
  });

  it('says the daemon is not running when the socket is missing', async () => {
    const r = await runCli(['--socket', path.join(dir, 'missing.sock'), 'status'], {
      call: (s, op, params) => call(s, op, params),
      stdout: () => undefined,
      stderr: () => undefined,
      now: Date.now,
      env: {},
    });
    expect(r).toBe(1);
  });
});
