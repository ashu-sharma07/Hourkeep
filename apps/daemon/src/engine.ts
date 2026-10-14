import { parseTarget, resolveRules, type GroupData, type Rule } from '@hourkeep/core';
import type { PlatformEnforcer, ReconcileResult } from '@hourkeep/platform';
import type { Logger } from './log.js';
import type { Store, StoredRule } from './store.js';

export type EngineFailure = { ok: false; code: 'invalid_target' | 'internal'; message: string };
export type EngineResult<T> = { ok: true; value: T } | EngineFailure;

export interface EngineDeps {
  readonly store: Store;
  readonly enforcer: PlatformEnforcer;
  readonly groups: GroupData;
  readonly logger: Logger;
  readonly dryRun: boolean;
  readonly clock?: () => number;
}

export interface EngineStatus {
  ruleCount: number;
  blockedDomainCount: number;
  lastReconcileAt: number | null;
  tamperCount: number;
  lastTamperAt: number | null;
  dryRun: boolean;
}

/**
 * Owns the desired state (rules in the store) and keeps the machine matching it. All
 * operations that touch the enforcer are serialised, so a client request can never race the
 * periodic check.
 */
export class Engine {
  private chain: Promise<unknown> = Promise.resolve();
  private lastReconcileAt: number | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.clock ?? Date.now;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Resolve once every operation queued so far has finished. */
  drain(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Hostnames that should currently be blocked. */
  desiredDomains(): string[] {
    return resolveRules(this.deps.store.listRules(), this.deps.groups.groups);
  }

  /** Apply the stored rules once at startup. A mismatch here is normal, not tampering. */
  start(): Promise<void> {
    return this.serial(async () => {
      this.deps.store.recordEvent('daemon_start', this.now(), null, {
        rules: this.deps.store.listRules().length,
      });
      await this.apply('update');
    });
  }

  /** Periodic check: restore anything that no longer matches and record tampering. */
  verify(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.apply('verify');
      } catch (e) {
        this.reportApplyError(e);
      }
    });
  }

  block(
    input: string,
    uid: number | null,
  ): Promise<EngineResult<{ rule: StoredRule; added: boolean; blockedDomainCount: number }>> {
    return this.serial(async () => {
      const parsed = parseTarget(input, this.deps.groups.groups);
      if (!parsed.ok) return { ok: false, code: 'invalid_target', message: parsed.error };
      const { rule, added } = this.deps.store.addRule(parsed.value, this.now());
      if (added) this.deps.store.recordEvent('rule_added', this.now(), uid, parsed.value);
      const applied = await this.applyForClient('saved the rule but could not apply it');
      if (!applied.ok) return applied;
      return { ok: true, value: { rule, added, blockedDomainCount: applied.value } };
    });
  }

  /** Remove a rule. Instant for now; M2 puts loosening behind cooldown and challenge. */
  unblock(
    input: string,
    uid: number | null,
  ): Promise<EngineResult<{ rule: Rule; removed: boolean; blockedDomainCount: number }>> {
    return this.serial(async () => {
      const parsed = parseTarget(input, this.deps.groups.groups);
      if (!parsed.ok) return { ok: false, code: 'invalid_target', message: parsed.error };
      const removed = this.deps.store.removeRule(parsed.value);
      if (removed) this.deps.store.recordEvent('rule_removed', this.now(), uid, parsed.value);
      const applied = await this.applyForClient('removed the rule but could not apply it');
      if (!applied.ok) return applied;
      return {
        ok: true,
        value: { rule: parsed.value, removed, blockedDomainCount: applied.value },
      };
    });
  }

  list(): { rules: StoredRule[]; blockedDomains: string[] } {
    return { rules: this.deps.store.listRules(), blockedDomains: this.desiredDomains() };
  }

  status(): EngineStatus {
    const { store, dryRun } = this.deps;
    return {
      ruleCount: store.listRules().length,
      blockedDomainCount: this.desiredDomains().length,
      lastReconcileAt: this.lastReconcileAt,
      tamperCount: store.countEvents('tamper'),
      lastTamperAt: store.lastEventTs('tamper'),
      dryRun,
    };
  }

  private async applyForClient(what: string): Promise<EngineResult<number>> {
    try {
      const r = await this.apply('update');
      return { ok: true, value: r.blockedCount };
    } catch (e) {
      this.reportApplyError(e);
      return {
        ok: false,
        code: 'internal',
        message: `${what}: ${(e as Error).message}. Will retry.`,
      };
    }
  }

  private async apply(intent: 'update' | 'verify'): Promise<ReconcileResult> {
    const result = await this.deps.enforcer.reconcile(this.desiredDomains(), intent);
    this.lastReconcileAt = this.now();
    this.lastError = null;
    if (result.tamper) {
      this.deps.store.recordEvent('tamper', this.now(), null, {
        kind: result.tamper,
        restored: result.written,
      });
      this.deps.logger.log('warn', 'tamper detected', {
        kind: result.tamper,
        restored: result.written,
      });
    } else if (result.written) {
      this.deps.logger.log('info', 'applied rules', {
        domains: result.blockedCount,
        method: result.method ?? '',
      });
    }
    return result;
  }

  /** Log and record a failure once per distinct message, not every interval. */
  private reportApplyError(e: unknown): void {
    const message = (e as Error).message;
    if (message === this.lastError) return;
    this.lastError = message;
    this.deps.logger.log('error', 'reconcile failed', { error: message });
    this.deps.store.recordEvent('reconcile_error', this.now(), null, { message });
  }
}
