import * as dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { slotStart, type Rule, type SuffixSpec } from '@hourkeep/core';
import type { DnsStatus } from '@hourkeep/ipc';
import {
  CANARY_DOMAIN,
  ResolverConfigurator,
  SuffixMatcher,
  startDnsServer,
  type CommandRunner,
  type DnsServer,
  type QueryEvent,
  type ResolverStrategy,
} from '@hourkeep/platform';
import type { DnsPort } from './engine.js';
import type { Logger } from './log.js';
import type { Store } from './store.js';

export interface DnsLayerOptions {
  readonly root: string;
  readonly dryRun: boolean;
  /** Where `dns-backup.json` lives. */
  readonly backupPath: string;
  readonly address: string;
  readonly port: number;
  /** Forward here instead of discovering the system's resolvers. */
  readonly upstreams: readonly string[];
  readonly store: Store;
  readonly logger: Logger;
  readonly clock?: () => number;
  readonly runner?: CommandRunner;
  readonly strategy?: 'auto' | ResolverStrategy;
  /** Resolve a name the way programs do (through the system). Replaceable for tests. */
  readonly lookup?: (name: string) => Promise<string[]>;
  /** Called when something changed the system's resolver settings and we put them back. */
  readonly onTamper?: (problem: string) => void;
  /** How often the canary check repeats (default 60 s). */
  readonly selfTestEveryMs?: number;
  readonly upstreamTimeoutMs?: number;
}

const systemLookup = async (name: string): Promise<string[]> =>
  (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

/**
 * The daemon's DNS layer: the resolver, the system configuration that points at it, the
 * counters, and the checks that keep it honest. It never takes over the system unless it
 * could bind its port and has somewhere to forward to, and `status()` says plainly when the
 * system does not actually use it.
 */
export class DnsLayer implements DnsPort {
  private server: DnsServer<Rule> | undefined;
  private cfg: ResolverConfigurator | undefined;
  private spec: SuffixSpec = { block: [], allow: [] };
  private strategy: ResolverStrategy | null = null;
  private inEffect: boolean | null = null;
  private upstreamCount = 0;
  private problem: string | null = null;
  private lastSelfTest = 0;
  private lastUpstreamRefresh = 0;
  private readonly blocked = new Map<
    string,
    { slot: number; suffix: string; rule: Rule; n: number }
  >();
  private totals = new Map<number, { forwarded: number; failed: number }>();
  private readonly now: () => number;

  constructor(private readonly o: DnsLayerOptions) {
    this.now = o.clock ?? Date.now;
  }

  /** The configurator for a given listening port (the port is only known once bound). */
  private configurator(port: number): ResolverConfigurator {
    return new ResolverConfigurator({
      root: this.o.root,
      dryRun: this.o.dryRun,
      backupPath: this.o.backupPath,
      listen: { address: this.o.address, port },
      knownUpstreams: this.o.upstreams,
      ...(this.o.runner ? { runner: this.o.runner } : {}),
      ...(this.o.strategy ? { strategy: this.o.strategy } : {}),
    });
  }

  private matcher(): SuffixMatcher<Rule> {
    return new SuffixMatcher<Rule>({ block: this.spec.block, allow: this.spec.allow });
  }

  private async currentUpstreams(): Promise<string[]> {
    return this.o.upstreams.length > 0
      ? [...this.o.upstreams]
      : (this.cfg ?? this.configurator(this.o.port)).upstreams();
  }

  /** Start serving and point the system at us. Failures leave the system untouched. */
  async start(): Promise<void> {
    if (this.o.dryRun) {
      this.problem = 'dry run: the DNS layer was not started';
      return;
    }
    const upstreams = await this.currentUpstreams();
    this.upstreamCount = upstreams.length;
    if (upstreams.length === 0) {
      this.problem = 'no usable upstream DNS server found, so the system resolver was left alone';
      this.o.logger.log('warn', 'dns layer not started', { reason: this.problem });
      return;
    }
    try {
      this.server = await startDnsServer<Rule>({
        address: this.o.address,
        port: this.o.port,
        upstreams: upstreams.map((address) => ({ address })),
        matcher: this.matcher(),
        canary: CANARY_DOMAIN,
        onQuery: (e) => this.count(e),
        onError: (e) =>
          this.o.logger.log('warn', 'dns server error', { error: (e as Error).message }),
        ...(this.o.upstreamTimeoutMs ? { upstreamTimeoutMs: this.o.upstreamTimeoutMs } : {}),
      });
    } catch (e) {
      this.problem = `cannot listen on ${this.o.address}:${this.o.port}: ${(e as Error).message}`;
      this.o.logger.log('error', 'dns layer not started', { reason: this.problem });
      return;
    }
    try {
      this.cfg = this.configurator(this.server.port);
      const r = await this.cfg.configure();
      this.strategy = r.strategy;
    } catch (e) {
      await this.server.close();
      this.server = undefined;
      this.problem = `could not configure the system resolver: ${(e as Error).message}`;
      this.o.logger.log('error', 'dns layer not started', { reason: this.problem });
      return;
    }
    this.lastUpstreamRefresh = this.now();
    await this.selfTest();
    this.o.logger.log('info', 'dns layer started', {
      listen: `${this.o.address}:${this.server.port}`,
      strategy: this.strategy,
      upstreams: upstreams.length,
      inEffect: String(this.inEffect),
    });
  }

  /** Check that programs asking the system reach us. */
  private async selfTest(): Promise<void> {
    this.lastSelfTest = this.now();
    const name = `hk-${randomBytes(4).toString('hex')}.${CANARY_DOMAIN}`;
    try {
      const addrs = await withTimeout((this.o.lookup ?? systemLookup)(name), 8000);
      this.inEffect = addrs.includes('127.0.0.1');
    } catch {
      this.inEffect = false;
    }
    this.problem = this.inEffect
      ? null
      : 'configured, but lookups from programs do not reach the hourkeep resolver (something else has priority, for example per-link DNS servers from NetworkManager). Blocking by domain does not apply to them.';
    if (!this.inEffect)
      this.o.logger.log('warn', 'dns layer is not in effect', { reason: this.problem ?? '' });
  }

  /** Periodic upkeep: put the system settings back if they were changed, refresh upstreams, re-run the canary. */
  async tick(): Promise<void> {
    this.flush();
    if (!this.server || !this.cfg) return;
    const now = this.now();
    try {
      const v = await this.cfg.verify();
      if (!v.ok) {
        this.o.logger.log('warn', 'resolver settings were changed; restoring', {
          problem: v.problem ?? '',
        });
        this.o.onTamper?.(v.problem ?? 'resolver settings changed');
        await this.cfg.configure();
        await this.selfTest();
      }
      if (now - this.lastUpstreamRefresh >= 60_000) {
        this.lastUpstreamRefresh = now;
        const ups = await this.currentUpstreams();
        if (ups.length > 0) {
          this.server.setUpstreams(ups.map((address) => ({ address })));
          this.upstreamCount = ups.length;
        }
      }
      if (now - this.lastSelfTest >= (this.o.selfTestEveryMs ?? 60_000)) await this.selfTest();
    } catch (e) {
      this.problem = `resolver upkeep failed: ${(e as Error).message}`;
      this.o.logger.log('error', 'dns upkeep failed', { error: (e as Error).message });
    }
  }

  setSpec(spec: SuffixSpec): void {
    this.spec = spec;
    this.server?.setMatcher(this.matcher());
  }

  private count(e: QueryEvent<Rule>): void {
    const slot = slotStart(this.now());
    if (e.kind === 'blocked') {
      const key = `${slot}|${e.suffix}|${e.owner.kind}|${e.owner.target}`;
      const cur = this.blocked.get(key);
      if (cur) cur.n++;
      else this.blocked.set(key, { slot, suffix: e.suffix, rule: e.owner, n: 1 });
    } else if (e.kind === 'forwarded' || e.kind === 'failed') {
      const t = this.totals.get(slot) ?? { forwarded: 0, failed: 0 };
      if (e.kind === 'forwarded') t.forwarded++;
      else t.failed++;
      this.totals.set(slot, t);
    }
  }

  /** Write buffered counters to the database. */
  flush(): void {
    if (this.blocked.size === 0 && this.totals.size === 0) return;
    const blocked = [...this.blocked.values()];
    const totals = [...this.totals.entries()];
    this.blocked.clear();
    this.totals = new Map();
    try {
      for (const b of blocked) this.o.store.addDnsBlocked(b.slot, b.suffix, b.rule, b.n);
      for (const [slot, t] of totals) this.o.store.addDnsTotals(slot, t.forwarded, t.failed);
    } catch (e) {
      this.o.logger.log('error', 'could not save DNS counters', { error: (e as Error).message });
    }
  }

  status(): Omit<DnsStatus, 'blockedToday'> {
    return {
      enabled: true,
      listening: this.server ? `${this.server.address}:${this.server.port}` : null,
      strategy: this.strategy,
      inEffect: this.server ? this.inEffect : null,
      upstreamCount: this.upstreamCount,
      problem: this.problem,
    };
  }

  /** Port the server is bound to (useful when configured with port 0 in tests). */
  get port(): number | null {
    return this.server?.port ?? null;
  }

  /** Stop serving. The system configuration is left in place, like the hosts block. */
  async stop(): Promise<void> {
    this.flush();
    await this.server?.close();
    this.server = undefined;
  }
}
