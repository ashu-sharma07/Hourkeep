import * as path from 'node:path';
import { parseArgs } from 'node:util';

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
}

export const DEFAULT_CONFIG: DaemonConfig = {
  root: '/',
  dryRun: false,
  socketPath: '/run/hourkeep/hourkeep.sock',
  socketGroup: 'hourkeep',
  stateDir: '/var/lib/hourkeep',
  reconcileIntervalMs: 5000,
  peercredPath: '/usr/lib/hourkeep/peercred.node',
};

export type Command = 'run' | 'teardown' | 'version' | 'help';

export const USAGE = `hourkeepd - Hourkeep root daemon

Usage: hourkeepd [options]
       hourkeepd --teardown      remove the managed hosts block and exit (used on uninstall)

Options:
  --root <dir>            treat <dir> as the filesystem root (default /)
  --dry-run               compute changes but write nothing
  --socket <path>         Unix socket path (default ${DEFAULT_CONFIG.socketPath})
  --group <name>          group owning the socket (default ${DEFAULT_CONFIG.socketGroup}); "" to disable
  --state-dir <dir>       where the database lives (default ${DEFAULT_CONFIG.stateDir})
  --interval-ms <n>       reconcile interval in ms, 100..3600000 (default ${DEFAULT_CONFIG.reconcileIntervalMs})
  --peercred <path>       SO_PEERCRED addon; "" to run without caller UIDs
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
