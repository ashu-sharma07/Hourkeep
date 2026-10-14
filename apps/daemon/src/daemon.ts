import * as fs from 'node:fs';
import * as path from 'node:path';
import { BUILTIN_GROUPS, type GroupData } from '@hourkeep/core';
import {
  PROTOCOL_VERSION,
  createIpcServer,
  type IpcServer,
  type PeerInfo,
  type RequestHandler,
} from '@hourkeep/ipc';
import { HostsFileEnforcer } from '@hourkeep/platform';
import type { DaemonConfig } from './config.js';
import { Engine } from './engine.js';
import type { Logger } from './log.js';
import type { Notifier } from './notify.js';
import { Store } from './store.js';
import { DAEMON_VERSION } from './version.js';

export interface DaemonDeps {
  readonly logger: Logger;
  readonly notifier: Notifier;
  /** Identify the process on the other end of a socket; omitted means "unknown". */
  readonly resolvePeer?: (socket: import('node:net').Socket) => PeerInfo | null;
  readonly groups?: GroupData;
  readonly clock?: () => number;
  /** For tests: override the group database used to resolve `socketGroup`. */
  readonly groupFile?: string;
}

export interface DaemonHandle {
  readonly engine: Engine;
  readonly socketPath: string;
  stop(): Promise<void>;
}

/** Find a group's numeric id in an /etc/group style file. */
export function lookupGid(name: string, groupFile = '/etc/group'): number | null {
  let text: string;
  try {
    text = fs.readFileSync(groupFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const [n, , gid] = line.split(':');
    if (n === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}

/** Translate validated IPC requests into engine calls. */
export function createHandler(engine: Engine, groups: GroupData): RequestHandler {
  return async (req, { peer }) => {
    const uid = peer?.uid ?? null;
    switch (req.op) {
      case 'status':
        return {
          ok: true,
          data: {
            daemonVersion: DAEMON_VERSION,
            protocol: PROTOCOL_VERSION,
            ...engine.status(),
            callerUid: uid,
          },
        };
      case 'list':
        return {
          ok: true,
          data: {
            ...engine.list(),
            groups: groups.groups.map((g) => ({
              id: g.id,
              name: g.name,
              domainCount: g.domains.length,
            })),
          },
        };
      case 'block': {
        const r = await engine.block(req.target, uid);
        return r.ok ? { ok: true, data: r.value } : { ok: false, code: r.code, message: r.message };
      }
      case 'unblock': {
        const r = await engine.unblock(req.target, uid);
        return r.ok
          ? {
              ok: true,
              data: {
                rule: { kind: r.value.rule.kind, target: r.value.rule.target },
                removed: r.value.removed,
                blockedDomainCount: r.value.blockedDomainCount,
              },
            }
          : { ok: false, code: r.code, message: r.message };
      }
    }
  };
}

/** Start the daemon: open state, apply rules, serve the socket, and watch for tampering. */
export async function startDaemon(config: DaemonConfig, deps: DaemonDeps): Promise<DaemonHandle> {
  const { logger, notifier } = deps;
  const groups = deps.groups ?? BUILTIN_GROUPS;

  if (config.root === '/' && !config.dryRun && process.getuid?.() !== 0) {
    throw new Error('hourkeepd must run as root to manage /etc/hosts (or use --root / --dry-run)');
  }

  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const dbFile = path.join(config.stateDir, 'hourkeep.db');
  const store = Store.open(dbFile);
  fs.chmodSync(dbFile, 0o600);

  const enforcer = new HostsFileEnforcer({ root: config.root, dryRun: config.dryRun });
  const engine = new Engine({
    store,
    enforcer,
    groups,
    logger,
    dryRun: config.dryRun,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  await engine.start();

  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o755 });
  let server: IpcServer;
  try {
    server = await createIpcServer({
      socketPath: config.socketPath,
      mode: 0o660,
      handler: createHandler(engine, groups),
      ...(deps.resolvePeer ? { resolvePeer: deps.resolvePeer } : {}),
      onError: (e) => logger.log('error', 'ipc error', { error: (e as Error).message }),
      onListening: (p) => {
        if (config.socketGroup === null) return;
        const gid = lookupGid(config.socketGroup, deps.groupFile);
        if (gid === null) {
          // Fail closed: without the group nobody but root may connect.
          fs.chmodSync(p, 0o600);
          logger.log('error', 'socket group not found; socket restricted to root', {
            group: config.socketGroup,
          });
          return;
        }
        fs.chownSync(p, fs.statSync(p).uid, gid); // keep the owner, change only the group
      },
    });
  } catch (e) {
    store.close();
    throw e;
  }

  let lastTick = Date.now();
  let stopped = false;
  const tick = setInterval(() => {
    void engine.verify().then(() => {
      lastTick = Date.now();
    });
  }, config.reconcileIntervalMs);

  // Only tell systemd we are alive while the check loop is actually running, so a wedged
  // daemon gets restarted instead of looking healthy.
  let watchdog: NodeJS.Timeout | undefined;
  if (notifier.watchdogMs !== null) {
    const healthyWithin = Math.max(config.reconcileIntervalMs * 3, 1000);
    watchdog = setInterval(
      () => {
        if (Date.now() - lastTick < healthyWithin) notifier.watchdog();
      },
      Math.max(100, Math.floor(notifier.watchdogMs / 2)),
    );
  }

  logger.log('info', 'hourkeepd started', {
    version: DAEMON_VERSION,
    socket: config.socketPath,
    dryRun: config.dryRun,
    root: config.root,
    intervalMs: config.reconcileIntervalMs,
  });
  notifier.ready('serving');

  return {
    engine,
    socketPath: config.socketPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(tick);
      if (watchdog) clearInterval(watchdog);
      notifier.stopping();
      await server.close();
      await engine.drain();
      store.close();
      logger.log('info', 'hourkeepd stopped');
    },
  };
}
