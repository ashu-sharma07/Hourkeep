import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonConfig } from './config.js';
import { silentLogger } from './log.js';
import type { Notifier } from './notify.js';

export const HOSTS_BASE = '127.0.0.1 localhost\n::1 localhost\n10.0.0.5 nas\n';

export interface Sandbox {
  readonly dir: string;
  readonly root: string;
  readonly hosts: string;
  readonly config: DaemonConfig;
  cleanup(): void;
}

/** A throwaway fake root, state dir and socket path. Nothing outside `dir` is touched. */
export function makeSandbox(overrides: Partial<DaemonConfig> = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-d-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  const hosts = path.join(root, 'etc', 'hosts');
  fs.writeFileSync(hosts, HOSTS_BASE);
  const config: DaemonConfig = {
    root,
    dryRun: false,
    socketPath: path.join(dir, 'run', 'hk.sock'),
    socketGroup: null,
    stateDir: path.join(dir, 'state'),
    reconcileIntervalMs: 100,
    peercredPath: null,
    ...overrides,
  };
  return {
    dir,
    root,
    hosts,
    config,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const silent = silentLogger;

export const noopNotifier: Notifier = {
  ready: () => undefined,
  stopping: () => undefined,
  watchdog: () => undefined,
  watchdogMs: null,
};

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}
