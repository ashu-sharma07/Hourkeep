import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PublicChallenge } from '@hourkeep/core';
import type { PublicChallengeWire } from '@hourkeep/ipc';
import { RCODE, buildQuery, rcodeOf } from '@hourkeep/platform';
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

/** Send one DNS query over UDP to 127.0.0.1:port; resolves with the response (null on timeout). */
export function dnsAsk(
  port: number,
  name: string,
  type = 1,
  timeoutMs = 2000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (r: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.close();
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.on('error', () => finish(null));
    s.on('message', (m) => finish(m));
    s.send(buildQuery(name, type, Math.floor(Math.random() * 65535)), port, '127.0.0.1');
  });
}

/** The response code for a lookup, or -1 when nothing answered. */
export async function dnsRcode(port: number, name: string, type = 1): Promise<number> {
  const r = await dnsAsk(port, name, type);
  return r ? (rcodeOf(r) ?? -1) : -1;
}

export { RCODE };

/** A port that was free a moment ago for both UDP and TCP (the DNS server needs both). */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const tcp = net.createServer();
    const port = await new Promise<number>((resolve) =>
      tcp.listen(0, '127.0.0.1', () => resolve((tcp.address() as net.AddressInfo).port)),
    );
    await new Promise((r) => tcp.close(r));
    const udp = dgram.createSocket('udp4');
    const ok = await new Promise<boolean>((resolve) => {
      udp.once('error', () => resolve(false));
      udp.bind(port, '127.0.0.1', () => resolve(true));
    });
    await new Promise<void>((r) => (ok ? udp.close(() => r()) : r()));
    if (ok) return port;
  }
  throw new Error('no free port');
}
