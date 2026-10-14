import { describe, expect, it } from 'vitest';
import { silentLogger } from './log.js';
import { createNotifier } from './notify.js';

describe('createNotifier', () => {
  it('does nothing outside systemd', () => {
    const calls: string[][] = [];
    const n = createNotifier({}, silentLogger, (_f, a) => calls.push(a));
    n.ready('x');
    n.watchdog();
    n.stopping();
    expect(calls).toEqual([]);
    expect(n.watchdogMs).toBeNull();
  });

  it('sends READY, WATCHDOG and STOPPING through systemd-notify', () => {
    const calls: string[][] = [];
    const n = createNotifier(
      { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '4000000' },
      silentLogger,
      (f, a) => {
        expect(f).toBe('systemd-notify');
        calls.push(a);
      },
    );
    n.ready('serving');
    n.watchdog();
    n.stopping();
    expect(calls).toEqual([['--ready', '--status=serving'], ['WATCHDOG=1'], ['--stopping']]);
    expect(n.watchdogMs).toBe(4000);
  });

  it('reports no watchdog when systemd did not enable one', () => {
    expect(
      createNotifier({ NOTIFY_SOCKET: '/x' }, silentLogger, () => undefined).watchdogMs,
    ).toBeNull();
  });
});
