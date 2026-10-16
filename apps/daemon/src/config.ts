import * as net from 'node:net';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CHALLENGE_KIND_IDS,
  DEFAULT_SETTINGS,
  DEFAULT_TIMING,
  isValidTimezone,
  type ChallengeKindId,
  type Settings,
  type Timing,
} from '@hourkeep/core';

export interface DaemonConfig {
  /** Directory treated as `/` by the platform layer. */
  readonly root: string;
  readonly dryRun: boolean;
  readonly socketPath: string;
  /** Group that owns the socket, or null to leave ownership alone (tests). */
  readonly socketGroup: string | null;
  readonly stateDir: string;
  readonly reconcileIntervalMs: number;
  /** Path of the SO_PEERCRED addon, or null to run without caller UIDs. */
  readonly peercredPath: string | null;
  /**
   * Protection settings written to the database the first time the daemon runs. After that
   * the database wins: they change only through the friction flow. `timezone` null means
   * the machine's timezone at first run.
   */
  readonly initialSettings: Omit<Settings, 'timezone'> & { readonly timezone: string | null };
  /** Challenge kinds that may be issued. */
  readonly challengeKinds: readonly ChallengeKindId[];
  readonly challengeTiming: Timing;
  /** The DNS layer (layer 2). Off unless asked for: it forwards your lookups and edits system DNS settings. */
  readonly dns: {
    readonly enabled: boolean;
    readonly address: string;
    readonly port: number;
    /** Forward to these instead of discovering the system's resolvers. */
    readonly upstreams: readonly string[];
  };
}

export const DEFAULT_CONFIG: DaemonConfig = {
  root: '/',
  dryRun: false,
  socketPath: '/run/hourkeep/hourkeep.sock',
  socketGroup: 'hourkeep',
  stateDir: '/var/lib/hourkeep',
  reconcileIntervalMs: 5000,
  peercredPath: '/usr/lib/hourkeep/peercred.node',
  initialSettings: { ...DEFAULT_SETTINGS, timezone: null },
  challengeKinds: CHALLENGE_KIND_IDS,
  challengeTiming: DEFAULT_TIMING,
  dns: { enabled: false, address: '127.0.0.1', port: 53, upstreams: [] },
};

export type Command = 'run' | 'teardown' | 'version' | 'help';

export const USAGE = `hourkeepd - Hourkeep root daemon

Usage: hourkeepd [options]
       hourkeepd --teardown      remove the hosts block, restore DNS settings, and exit (used on uninstall)

Options:
  --root <dir>            treat <dir> as the filesystem root (default /)
  --dry-run               compute changes but write nothing
  --socket <path>         Unix socket path (default ${DEFAULT_CONFIG.socketPath})
  --group <name>          group owning the socket (default ${DEFAULT_CONFIG.socketGroup}); "" to disable
  --state-dir <dir>       where the database lives (default ${DEFAULT_CONFIG.stateDir})
  --interval-ms <n>       reconcile interval in ms, 100..3600000 (default ${DEFAULT_CONFIG.reconcileIntervalMs})
  --peercred <path>       SO_PEERCRED addon; "" to run without caller UIDs

First-run defaults (stored in the database; later changes go through cooldown and challenge):
  --cooldown-seconds <n>  initial cooldown before a loosening change can be confirmed (default 600)
  --passes-per-day <n>    initial temporary passes per day (default 3)
  --pass-minutes <n>      initial pass length (default 15)
  --timezone <iana>       initial timezone for per-day counting (default: this machine's)

DNS layer (blocks whole domains, so subdomains like *.googlevideo.com are covered):
  --dns                   run the local resolver and point the system at it (off by default)
  --dns-listen <a:p>      where it listens (default 127.0.0.1:53; the resolv.conf method needs port 53)
  --upstream <address>    forward allowed lookups here instead of the system's resolvers (repeatable)

Challenges:
  --challenge-kinds <list>        comma separated: typing,arithmetic,reflection (default all)
  --reflection-wait-seconds <n>   how long the reflection screen makes you wait (default 30)
  --min-answer-seconds <n>        minimum time before a typing or arithmetic answer (default 5)
  --version, --help
`;

export class ConfigError extends Error {}

/** Parse command-line flags. Throws ConfigError with a user-facing message. */
export function parseConfig(argv: readonly string[]): { command: Command; config: DaemonConfig } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: 'string' },
        'dry-run': { type: 'boolean' },
        socket: { type: 'string' },
        group: { type: 'string' },
        'state-dir': { type: 'string' },
        'interval-ms': { type: 'string' },
        peercred: { type: 'string' },
        'cooldown-seconds': { type: 'string' },
        'passes-per-day': { type: 'string' },
        'pass-minutes': { type: 'string' },
        timezone: { type: 'string' },
        'challenge-kinds': { type: 'string' },
        'reflection-wait-seconds': { type: 'string' },
        'min-answer-seconds': { type: 'string' },
        dns: { type: 'boolean' },
        'dns-listen': { type: 'string' },
        upstream: { type: 'string', multiple: true },
        teardown: { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const abs = (flag: string, v: string): string => {
    if (!path.isAbsolute(v)) throw new ConfigError(`--${flag} must be an absolute path`);
    return path.normalize(v);
  };

  const intervalRaw = values['interval-ms'];
  let interval = DEFAULT_CONFIG.reconcileIntervalMs;
  if (intervalRaw !== undefined) {
    interval = Number(intervalRaw);
    if (!Number.isInteger(interval) || interval < 100 || interval > 3_600_000) {
      throw new ConfigError('--interval-ms must be an integer between 100 and 3600000');
    }
  }

  const whole = (flag: string, min: number, max: number, fallback: number): number => {
    const raw = values[flag as keyof typeof values];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || n < min || n > max) {
      throw new ConfigError(`--${flag} must be a whole number between ${min} and ${max}`);
    }
    return n;
  };

  let kinds: readonly ChallengeKindId[] = DEFAULT_CONFIG.challengeKinds;
  if (values['challenge-kinds'] !== undefined) {
    const list = values['challenge-kinds']
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const bad = list.find((k) => !(CHALLENGE_KIND_IDS as readonly string[]).includes(k));
    if (list.length === 0 || bad !== undefined) {
      throw new ConfigError(
        `--challenge-kinds must be a comma separated list of: ${CHALLENGE_KIND_IDS.join(', ')}`,
      );
    }
    kinds = [...new Set(list)] as ChallengeKindId[];
  }

  if (values.timezone !== undefined && !isValidTimezone(values.timezone)) {
    throw new ConfigError(`--timezone: unknown timezone "${values.timezone}"`);
  }

  let dnsAddress = DEFAULT_CONFIG.dns.address;
  let dnsPort = DEFAULT_CONFIG.dns.port;
  if (values['dns-listen'] !== undefined) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(values['dns-listen']);
    if (!m || net.isIPv4(m[1] as string) === false || Number(m[2]) < 1 || Number(m[2]) > 65535) {
      throw new ConfigError('--dns-listen must look like 127.0.0.1:53');
    }
    dnsAddress = m[1] as string;
    dnsPort = Number(m[2]);
  }
  const upstreams = values.upstream ?? [];
  for (const u of upstreams) {
    if (net.isIP(u) === 0) throw new ConfigError(`--upstream "${u}" is not an IP address`);
    if (/^127\./.test(u) || u === '::1')
      throw new ConfigError(
        '--upstream must not be a loopback address (that would be this resolver)',
      );
  }

  const config: DaemonConfig = {
    root: values.root !== undefined ? abs('root', values.root) : DEFAULT_CONFIG.root,
    dryRun: values['dry-run'] ?? false,
    socketPath:
      values.socket !== undefined ? abs('socket', values.socket) : DEFAULT_CONFIG.socketPath,
    socketGroup: values.group !== undefined ? values.group || null : DEFAULT_CONFIG.socketGroup,
    stateDir:
      values['state-dir'] !== undefined
        ? abs('state-dir', values['state-dir'])
        : DEFAULT_CONFIG.stateDir,
    reconcileIntervalMs: interval,
    peercredPath:
      values.peercred !== undefined
        ? values.peercred
          ? abs('peercred', values.peercred)
          : null
        : DEFAULT_CONFIG.peercredPath,
    initialSettings: {
      cooldownSeconds: whole('cooldown-seconds', 1, 43_200, DEFAULT_SETTINGS.cooldownSeconds),
      passesPerDay: whole('passes-per-day', 0, 24, DEFAULT_SETTINGS.passesPerDay),
      passMinutes: whole('pass-minutes', 1, 180, DEFAULT_SETTINGS.passMinutes),
      timezone: values.timezone ?? null,
    },
    dns: { enabled: values.dns ?? false, address: dnsAddress, port: dnsPort, upstreams },
    challengeKinds: kinds,
    challengeTiming: {
      reflectionWaitMs:
        whole('reflection-wait-seconds', 0, 3600, DEFAULT_TIMING.reflectionWaitMs / 1000) * 1000,
      minAnswerMs: whole('min-answer-seconds', 0, 600, DEFAULT_TIMING.minAnswerMs / 1000) * 1000,
    },
  };

  const command: Command = values.help
    ? 'help'
    : values.version
      ? 'version'
      : values.teardown
        ? 'teardown'
        : 'run';
  return { command, config };
}
