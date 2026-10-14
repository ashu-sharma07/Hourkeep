import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PublicChallenge } from '@hourkeep/core';
import type { PublicChallengeWire } from '@hourkeep/ipc';
import { DEFAULT_CONFIG, type DaemonConfig } from './config.js';
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
    ...DEFAULT_CONFIG,
    root,
    dryRun: false,
    socketPath: path.join(dir, 'run', 'hk.sock'),
    socketGroup: null,
    stateDir: path.join(dir, 'state'),
    reconcileIntervalMs: 100,
    peercredPath: null,
    initialSettings: { ...DEFAULT_CONFIG.initialSettings, timezone: 'UTC' },
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

/** A clock tests move by hand. Starts on Wednesday 2026-10-14 12:00 UTC. */
export class FakeClock {
  t: number;
  constructor(start = Date.parse('2026-10-14T12:00:00Z')) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

export const SECOND = 1000;
export const MINUTE = 60_000;

/** What a person would type for a challenge, worked out from what they can see. */
export function solve(c: PublicChallenge | PublicChallengeWire): string {
  const d = c.data;
  switch (d.kind) {
    case 'typing':
      return d.text;
    case 'arithmetic':
      return d.problems
        .map((p) =>
          String(Function(`"use strict"; return (${p.replace(/×/g, '*').replace(/−/g, '-')});`)()),
        )
        .join(' ');
    case 'reflection':
      return 'I have a deadline tomorrow and need this one site for the lecture video';
  }
}
