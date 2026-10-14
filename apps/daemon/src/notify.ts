import { execFile } from 'node:child_process';
import type { Logger } from './log.js';

/** Talks to systemd. Node cannot send datagrams to NOTIFY_SOCKET, so `systemd-notify` does. */
export interface Notifier {
  ready(status: string): void;
  stopping(): void;
  watchdog(): void;
  /** Watchdog period in ms, or null when systemd did not enable one. */
  readonly watchdogMs: number | null;
}

type Exec = (file: string, args: string[]) => void;

export function createNotifier(
  env: NodeJS.ProcessEnv,
  logger: Logger,
  exec: Exec = (file, args) =>
    execFile(file, args, { timeout: 5000 }, (err) => {
      if (err) logger.log('warn', 'systemd-notify failed', { error: err.message });
    }),
): Notifier {
  if (!env['NOTIFY_SOCKET']) {
    return {
      ready: () => undefined,
      stopping: () => undefined,
      watchdog: () => undefined,
      watchdogMs: null,
    };
  }
  const usec = Number(env['WATCHDOG_USEC'] ?? 0);
  return {
    ready: (status) => exec('systemd-notify', ['--ready', `--status=${status}`]),
    stopping: () => exec('systemd-notify', ['--stopping']),
    watchdog: () => exec('systemd-notify', ['WATCHDOG=1']),
    watchdogMs: usec > 0 ? Math.floor(usec / 1000) : null,
  };
}
