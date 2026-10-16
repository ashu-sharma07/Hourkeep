import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BUILTIN_GROUPS,
  isValidTimezone,
  type GroupData,
  type PublicChallenge,
  type Rng,
} from '@hourkeep/core';
import {
  PROTOCOL_VERSION,
  createIpcServer,
  type ChangeOutcome,
  type DataOf,
  type ErrorCode,
  type HandlerResult,
  type IpcServer,
  type Op,
  type PeerInfo,
  type PublicChallengeWire,
  type RequestHandler,
} from '@hourkeep/ipc';
import { HostsFileEnforcer, type CommandRunner, type ResolverStrategy } from '@hourkeep/platform';
import type { DaemonConfig } from './config.js';
import { DnsLayer } from './dns-layer.js';
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
  readonly bootClock?: () => number;
  readonly rng?: Rng;
  /** For tests: override the group database used to resolve `socketGroup`. */
  readonly groupFile?: string;
  /** For tests: run system commands (systemctl) through this instead of the real thing. */
  readonly runner?: CommandRunner;
  readonly dnsStrategy?: 'auto' | ResolverStrategy;
  /** For tests: how the self-test resolves a name "through the system". */
  readonly dnsLookup?: (name: string) => Promise<string[]>;
  readonly dnsSelfTestEveryMs?: number;
  readonly dnsUpstreamTimeoutMs?: number;
}

export interface DaemonHandle {
  readonly engine: Engine;
  readonly socketPath: string;
  stop(): Promise<void>;
}

/** The machine's IANA timezone, or UTC if it cannot be determined. */
export function machineTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimezone(tz) ? tz : 'UTC';
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

function toWireChallenge(c: PublicChallenge): PublicChallengeWire {
  const d = c.data;
  const data: PublicChallengeWire['data'] =
    d.kind === 'arithmetic' ? { kind: 'arithmetic', problems: [...d.problems] } : d;
  return {
    id: c.id,
    issuedAt: c.issuedAt,
    earliestAnswerAt: c.earliestAnswerAt,
    instructions: c.instructions,
    data,
  };
}

type Result_<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** Engine result to handler result, mapping the success value. */
function through<T>(r: Result_<T>, map: (v: T) => DataOf<Op>): HandlerResult<Op> {
  return r.ok ? { ok: true, data: map(r.value) } : { ok: false, code: r.code, message: r.message };
}

/** Translate validated IPC requests into engine calls. */
export function createHandler(engine: Engine, groups: GroupData): RequestHandler {
  return async (req, { peer }) => {
    const uid = peer?.uid ?? null;
    const outcome = (r: Result_<ChangeOutcome>) => through(r, (v) => v);
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
      case 'block':
        return through(await engine.block(req.target, uid), (v) => ({
          rule: { kind: v.rule.kind, target: v.rule.target, createdAt: v.rule.createdAt },
          added: v.added,
          blockedDomainCount: v.blockedDomainCount,
        }));
      case 'unblock':
        return outcome(await engine.requestUnblock(req.target, uid));
      case 'schedule_set':
        return outcome(await engine.requestSchedule(req.target, req.schedule, uid));
      case 'schedule_clear':
        return outcome(await engine.requestSchedule(req.target, null, uid));
      case 'limit_set':
        return outcome(await engine.requestLimit(req.target, req.minutes, uid));
      case 'settings_get':
        return { ok: true, data: engine.settings() };
      case 'settings_set':
        return outcome(await engine.requestSetting(req.key, req.value, uid));
      case 'pending_list':
        return { ok: true, data: { changes: engine.listPending() } };
      case 'pending_cancel':
        return through(await engine.cancelPending(req.changeId, uid), (message) => ({ message }));
      case 'pending_challenge':
        return through(await engine.challengeFor(req.changeId), (v) => ({
          challenge: toWireChallenge(v.challenge),
          attemptsLeft: v.attemptsLeft,
        }));
      case 'pending_answer':
        return through(await engine.answer(req.changeId, req.response, uid), (v) =>
          'result' in v
            ? v
            : {
                result: 'wrong' as const,
                hint: v.hint,
                attemptsLeft: v.attemptsLeft,
                newChallenge: v.newChallenge === null ? null : toWireChallenge(v.newChallenge),
              },
        );
      case 'pass_start':
        return outcome(await engine.requestPass(req.target, uid));
      case 'pass_end':
        return outcome(await engine.endPass(req.target, uid));
      case 'stats':
        return { ok: true, data: engine.stats(req.range) };
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
  const clock = deps.clock ?? Date.now;
  const dnsLayer = config.dns.enabled
    ? new DnsLayer({
        root: config.root,
        dryRun: config.dryRun,
        backupPath: path.join(config.stateDir, 'dns-backup.json'),
        address: config.dns.address,
        port: config.dns.port,
        upstreams: config.dns.upstreams,
        store,
        logger,
        clock,
        onTamper: (problem) =>
          store.recordEvent('tamper', clock(), null, { kind: 'dns-config', problem }),
        ...(deps.runner ? { runner: deps.runner } : {}),
        ...(deps.dnsStrategy ? { strategy: deps.dnsStrategy } : {}),
        ...(deps.dnsLookup ? { lookup: deps.dnsLookup } : {}),
        ...(deps.dnsSelfTestEveryMs ? { selfTestEveryMs: deps.dnsSelfTestEveryMs } : {}),
        ...(deps.dnsUpstreamTimeoutMs ? { upstreamTimeoutMs: deps.dnsUpstreamTimeoutMs } : {}),
      })
    : undefined;
  const engine = new Engine({
    store,
    enforcer,
    groups,
    logger,
    dryRun: config.dryRun,
    defaults: {
      ...config.initialSettings,
      timezone: config.initialSettings.timezone ?? machineTimezone(),
    },
    challengeKinds: config.challengeKinds,
    timing: config.challengeTiming,
    intervalMs: config.reconcileIntervalMs,
    ...(dnsLayer ? { dns: dnsLayer } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.bootClock ? { bootClock: deps.bootClock } : {}),
    ...(deps.rng ? { rng: deps.rng } : {}),
  });
  await engine.start();
  if (dnsLayer) await dnsLayer.start();

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
    void engine
      .verify()
      .then(() => dnsLayer?.tick())
      .then(() => {
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
      await dnsLayer?.stop();
      store.close();
      logger.log('info', 'hourkeepd stopped');
    },
  };
}
