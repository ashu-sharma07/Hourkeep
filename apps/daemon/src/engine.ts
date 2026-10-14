import {
  compareLimit,
  compareSettings,
  dateKey,
  decidePass,
  describeSchedule,
  isActive,
  loosensSchedule,
  makeSchedule,
  parseSetting,
  parseTarget,
  resolveRules,
  scheduleEquals,
  secureRng,
  type ChallengeKindId,
  type GroupData,
  type PublicChallenge,
  type Result,
  type Rng,
  type Rule,
  type Settings,
  type Timing,
  type WeeklySchedule,
} from '@hourkeep/core';
import type { ChangeOutcome, PendingView, RuleDetail, ScheduleWire } from '@hourkeep/ipc';
import type { PlatformEnforcer, ReconcileResult } from '@hourkeep/platform';
import { bootClockMs } from './clock.js';
import { formatDuration, summarize, type Change } from './changes.js';
import type { Logger } from './log.js';
import { PendingChanges, type AnswerResult, type Failure, type Res } from './pending.js';
import type { PassRow, Store, StoredRule } from './store.js';

export type { Failure, Res } from './pending.js';

const fail = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });
const ruleKey = (r: Rule): string => `${r.kind}:${r.target}`;

export interface EngineDeps {
  readonly store: Store;
  readonly enforcer: PlatformEnforcer;
  readonly groups: GroupData;
  readonly logger: Logger;
  readonly dryRun: boolean;
  /** Settings written to the database the first time the daemon runs. */
  readonly defaults: Settings;
  readonly challengeKinds: readonly ChallengeKindId[];
  readonly timing?: Partial<Timing>;
  readonly clock?: () => number;
  /** Monotonic clock that includes suspend; used to notice the wall clock being set. */
  readonly bootClock?: () => number;
  readonly rng?: Rng;
}

export interface EngineStatus {
  ruleCount: number;
  blockedDomainCount: number;
  lastReconcileAt: number | null;
  tamperCount: number;
  lastTamperAt: number | null;
  pendingCount: number;
  passesUsedToday: number;
  passesPerDay: number;
  dryRun: boolean;
}

const CLOCK_JUMP_THRESHOLD_MS = 60_000;

/**
 * Owns the protection state (rules, schedules, limits, passes, settings and pending changes)
 * and keeps the machine matching it. Tightening applies at once; loosening goes through
 * the cooldown and challenge in `PendingChanges`. All operations are serialised, so a
 * client request can never race the periodic check.
 */
export class Engine {
  private chain: Promise<unknown> = Promise.resolve();
  private lastReconcileAt: number | null = null;
  private lastError: string | null = null;
  private lastAppliedKey: string | null = null;
  private lastWall: number | null = null;
  private lastBoot = 0;
  private readonly now: () => number;
  private readonly boot: () => number;
  private readonly pending: PendingChanges;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.clock ?? Date.now;
    this.boot = deps.bootClock ?? bootClockMs;
    this.pending = new PendingChanges({
      store: deps.store,
      clock: this.now,
      rng: deps.rng ?? secureRng(),
      kinds: deps.challengeKinds,
      timing: deps.timing,
      logger: deps.logger,
    });
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

  // ---- state reads ------------------------------------------------------------------------

  settings(): Settings {
    const s = this.deps.store.settings();
    const d = this.deps.defaults;
    const num = (v: string | undefined, fallback: number): number => {
      const n = Number(v);
      return v !== undefined && Number.isFinite(n) ? n : fallback;
    };
    return {
      cooldownSeconds: num(s['cooldown_seconds'], d.cooldownSeconds),
      passesPerDay: num(s['passes_per_day'], d.passesPerDay),
      passMinutes: num(s['pass_minutes'], d.passMinutes),
      timezone: s['timezone'] ?? d.timezone,
    };
  }

  private writeSettings(patch: Partial<Settings>): void {
    const st = this.deps.store;
    if (patch.cooldownSeconds !== undefined)
      st.setSetting('cooldown_seconds', String(patch.cooldownSeconds));
    if (patch.passesPerDay !== undefined)
      st.setSetting('passes_per_day', String(patch.passesPerDay));
    if (patch.passMinutes !== undefined) st.setSetting('pass_minutes', String(patch.passMinutes));
    if (patch.timezone !== undefined) st.setSetting('timezone', patch.timezone);
  }

  /** Rules that are blocking at `now`: schedule active and no pass running. */
  private blockingRules(now: number): StoredRule[] {
    const passes = this.deps.store.activePasses(now);
    return this.deps.store
      .listRules()
      .filter(
        (r) =>
          isActive(r.schedule, now) &&
          !passes.some((p) => p.kind === r.kind && p.target === r.target),
      );
  }

  /** Hostnames that should be blocked right now. */
  desiredDomains(now: number = this.now()): string[] {
    return resolveRules(this.blockingRules(now), this.deps.groups.groups);
  }

  private findRule(input: string): Res<StoredRule> {
    const parsed = parseTarget(input, this.deps.groups.groups);
    if (!parsed.ok) return fail('invalid_target', parsed.error);
    const rule = this.deps.store.getRule(parsed.value);
    if (!rule) {
      return fail(
        'not_found',
        `no rule for ${parsed.value.target}. Block it first: hourkeep block ${input.trim()}`,
      );
    }
    return { ok: true, value: rule };
  }

  private dayKey(now: number): string {
    return dateKey(now, this.settings().timezone);
  }

  private passLikes(now: number) {
    return this.deps.store.passesOnDay(this.dayKey(now)).map((p) => ({
      ruleKey: ruleKey(p),
      dayKey: p.dayKey,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      endedAt: p.endedAt,
    }));
  }

  private runningPass(rule: Rule, now: number): PassRow | null {
    return (
      this.deps.store
        .activePasses(now)
        .find((p) => p.kind === rule.kind && p.target === rule.target) ?? null
    );
  }

  // ---- lifecycle --------------------------------------------------------------------------

  /** Seed settings on first run, then apply the stored state. A mismatch here is normal, not tampering. */
  start(): Promise<void> {
    return this.serial(async () => {
      const d = this.deps.defaults;
      const st = this.deps.store;
      st.seedSetting('cooldown_seconds', String(d.cooldownSeconds));
      st.seedSetting('passes_per_day', String(d.passesPerDay));
      st.seedSetting('pass_minutes', String(d.passMinutes));
      st.seedSetting('timezone', d.timezone);
      this.lastWall = this.now();
      this.lastBoot = this.boot();
      st.recordEvent('daemon_start', this.lastWall, null, { rules: st.listRules().length });
      this.pending.expireDue();
      await this.apply(true);
    });
  }

  /**
   * Periodic check: expire stale requests, follow schedule and pass transitions, restore
   * anything that no longer matches and record tampering.
   */
  verify(): Promise<void> {
    return this.serial(async () => {
      this.checkClock();
      this.endLapsedPasses();
      this.pending.expireDue();
      try {
        await this.apply(false);
      } catch (e) {
        this.reportApplyError(e);
      }
    });
  }

  private checkClock(): void {
    const wall = this.now();
    const boot = this.boot();
    if (this.lastWall !== null) {
      const wallDelta = wall - this.lastWall;
      const bootDelta = boot - this.lastBoot;
      if (Math.abs(wallDelta - bootDelta) > CLOCK_JUMP_THRESHOLD_MS) {
        this.deps.store.recordEvent('clock_jump', wall, null, {
          wallDeltaMs: wallDelta,
          bootDeltaMs: bootDelta,
        });
        this.deps.logger.log('warn', 'system clock changed', {
          wallDeltaMs: wallDelta,
          bootDeltaMs: bootDelta,
        });
      }
    }
    this.lastWall = wall;
    this.lastBoot = boot;
  }

  /** Passes that ran out their time are over; record that once. */
  private endLapsedPasses(): void {
    const now = this.now();
    const active = new Set(this.deps.store.activePasses(now).map((p) => p.id));
    for (const p of this.deps.store.passesOnDay(this.dayKey(now))) {
      if (p.endedAt === null && p.endsAt <= now && !active.has(p.id)) {
        this.deps.store.endPass(p.id, p.endsAt);
        this.deps.store.recordEvent('pass_ended', now, null, {
          id: p.id,
          target: p.target,
          reason: 'expired',
        });
      }
    }
  }

  /**
   * Make the machine match the desired set. If the desired set changed since the last pass
   * (rule change, schedule transition, pass start or end) it is an `update`; otherwise a
   * `verify`, where any difference is tampering.
   */
  private async apply(forceUpdate: boolean): Promise<ReconcileResult> {
    const desired = this.desiredDomains();
    const key = desired.join('\n');
    const intent = forceUpdate || key !== this.lastAppliedKey ? 'update' : 'verify';
    const result = await this.deps.enforcer.reconcile(desired, intent);
    this.lastAppliedKey = key;
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

  /** Apply after a client-requested change; a failure is reported to the client and retried by the loop. */
  private async applyForClient(what: string): Promise<Failure | null> {
    try {
      await this.apply(true);
      return null;
    } catch (e) {
      this.reportApplyError(e);
      return fail('internal', `${what}: ${(e as Error).message}. Will retry.`);
    }
  }

  // ---- tightening that is not a Change ---------------------------------------------------

  /** Add a block rule. Always tightening, so always instant. */
  block(input: string, uid: number | null) {
    return this.serial(
      async (): Promise<Res<{ rule: StoredRule; added: boolean; blockedDomainCount: number }>> => {
        const parsed = parseTarget(input, this.deps.groups.groups);
        if (!parsed.ok) return fail('invalid_target', parsed.error);
        const { rule, added } = this.deps.store.addRule(parsed.value, this.now());
        if (added) this.deps.store.recordEvent('rule_added', this.now(), uid, parsed.value);
        const f = await this.applyForClient('saved the rule but could not apply it');
        if (f) return f;
        return {
          ok: true,
          value: { rule, added, blockedDomainCount: this.desiredDomains().length },
        };
      },
    );
  }

  /** End a running pass early. Tightening, so instant. */
  endPass(input: string, uid: number | null) {
    return this.serial(async (): Promise<Res<ChangeOutcome>> => {
      const r = this.findRule(input);
      if (!r.ok) return r;
      const pass = this.runningPass(r.value, this.now());
      if (!pass)
        return {
          ok: true,
          value: { status: 'noop', message: `No pass is running on ${r.value.target}.` },
        };
      this.deps.store.endPass(pass.id, this.now());
      this.deps.store.recordEvent('pass_ended', this.now(), uid, {
        id: pass.id,
        target: pass.target,
        reason: 'ended',
      });
      const f = await this.applyForClient('ended the pass but could not apply it');
      if (f) return f;
      return {
        ok: true,
        value: { status: 'applied', message: `Pass on ${r.value.target} ended. Blocking again.` },
      };
    });
  }

  // ---- changes: classify, then apply now or make the user wait --------------------------

  requestUnblock(input: string, uid: number | null) {
    return this.serial(async () => {
      const r = this.findRule(input);
      return r.ok ? this.submit({ kind: 'remove_rule', rule: toRule(r.value) }, uid) : r;
    });
  }

  requestSchedule(input: string, schedule: ScheduleWire | null, uid: number | null) {
    return this.serial(async () => {
      const r = this.findRule(input);
      if (!r.ok) return r;
      let next = null;
      if (schedule !== null) {
        const made = makeScheduleFromWire(schedule);
        if (!made.ok) return fail('invalid_value', made.error);
        next = made.value;
      }
      return this.submit({ kind: 'set_schedule', rule: toRule(r.value), schedule: next }, uid);
    });
  }

  requestLimit(input: string, minutes: number | null, uid: number | null) {
    return this.serial(async () => {
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) {
        return fail(
          'invalid_value',
          'the limit must be a whole number of minutes between 0 and 1440',
        );
      }
      const r = this.findRule(input);
      return r.ok ? this.submit({ kind: 'set_limit', rule: toRule(r.value), minutes }, uid) : r;
    });
  }

  requestSetting(key: string, value: string, uid: number | null) {
    return this.serial(async () => {
      const parsed = parseSetting(key, value);
      if (!parsed.ok) return fail('invalid_value', parsed.error);
      return this.submit({ kind: 'set_setting', patch: parsed.value }, uid);
    });
  }

  requestPass(input: string, uid: number | null) {
    return this.serial(async () => {
      const r = this.findRule(input);
      return r.ok ? this.submit({ kind: 'start_pass', rule: toRule(r.value) }, uid) : r;
    });
  }

  /** Decide what a change means right now. */
  private classify(
    change: Change,
  ): Res<{ how: 'noop'; message: string } | { how: 'tighten' } | { how: 'loosen' }> {
    const now = this.now();
    const st = this.deps.store;
    const noop = (message: string) => ({
      ok: true as const,
      value: { how: 'noop' as const, message },
    });
    switch (change.kind) {
      case 'remove_rule':
        return { ok: true, value: { how: 'loosen' } };
      case 'set_schedule': {
        const cur = st.getRule(change.rule)?.schedule ?? null;
        if (scheduleEquals(cur, change.schedule))
          return noop(`${change.rule.target} already has that schedule.`);
        return {
          ok: true,
          value: { how: loosensSchedule(cur, change.schedule) ? 'loosen' : 'tighten' },
        };
      }
      case 'set_limit': {
        const cur = st.getRule(change.rule)?.dailyLimitMinutes ?? null;
        const d = compareLimit(cur, change.minutes);
        return d === 'same'
          ? noop(`${change.rule.target} already has that limit.`)
          : { ok: true, value: { how: d } };
      }
      case 'set_setting': {
        const d = compareSettings(this.settings(), change.patch);
        return d === 'same' ? noop('Nothing to change.') : { ok: true, value: { how: d } };
      }
      case 'start_pass': {
        const rule = st.getRule(change.rule);
        if (!rule) return fail('not_found', `no rule for ${change.rule.target}`);
        if (!isActive(rule.schedule, now)) {
          return noop(
            `${rule.target} is not being blocked right now (schedule), so there is nothing to pass.`,
          );
        }
        const running = this.runningPass(change.rule, now);
        if (running)
          return noop(
            `A pass on ${rule.target} is already running until ${new Date(running.endsAt).toISOString()}.`,
          );
        const d = this.passDecision(rule, now);
        return d.ok ? { ok: true, value: { how: 'loosen' } } : fail('limit_reached', d.reason);
      }
    }
  }

  private passDecision(rule: StoredRule, now: number) {
    return decidePass({
      passes: this.passLikes(now),
      ruleKey: ruleKey(rule),
      dayKey: this.dayKey(now),
      now,
      settings: this.settings(),
      ruleLimitMinutes: rule.dailyLimitMinutes,
    });
  }

  private async submit(change: Change, uid: number | null): Promise<Res<ChangeOutcome>> {
    const c = this.classify(change);
    if (!c.ok) return c;
    if (c.value.how === 'noop')
      return { ok: true, value: { status: 'noop', message: c.value.message } };
    if (c.value.how === 'tighten') {
      const done = await this.applyChange(change, uid, null);
      return done.ok ? { ok: true, value: { status: 'applied', message: done.value } } : done;
    }
    const existing = this.pending.findOpen(change);
    const row =
      existing ??
      this.pending.request(
        change,
        uid,
        change.kind === 'start_pass' ? 0 : this.settings().cooldownSeconds * 1000,
      );
    return { ok: true, value: { status: 'pending', change: this.pending.view(row) } };
  }

  /** Make the change real: update state, record it, reconcile. Used for tightening and after a challenge. */
  private async applyChange(
    change: Change,
    uid: number | null,
    reflection: string | null,
  ): Promise<Res<string>> {
    const st = this.deps.store;
    const now = this.now();
    let message: string;
    switch (change.kind) {
      case 'remove_rule': {
        if (!st.removeRule(change.rule))
          return fail('not_found', `${change.rule.target} is no longer blocked`);
        st.recordEvent('rule_removed', now, uid, { ...change.rule, reflection });
        message = `Stopped blocking ${change.rule.target}.`;
        break;
      }
      case 'set_schedule': {
        if (!st.getRule(change.rule))
          return fail('not_found', `${change.rule.target} is no longer blocked`);
        st.setSchedule(change.rule, change.schedule, now);
        st.recordEvent('schedule_changed', now, uid, {
          rule: change.rule,
          schedule: describeSchedule(change.schedule),
          reflection,
        });
        message = `Schedule of ${change.rule.target} is now: ${describeSchedule(change.schedule)}.`;
        break;
      }
      case 'set_limit': {
        if (!st.getRule(change.rule))
          return fail('not_found', `${change.rule.target} is no longer blocked`);
        st.setLimit(change.rule, change.minutes, now);
        st.recordEvent('limit_changed', now, uid, {
          rule: change.rule,
          minutes: change.minutes,
          reflection,
        });
        message =
          change.minutes === null
            ? `Daily limit of ${change.rule.target} removed.`
            : `Daily limit of ${change.rule.target} is now ${change.minutes} minutes.`;
        break;
      }
      case 'set_setting': {
        this.writeSettings(change.patch);
        st.recordEvent('setting_changed', now, uid, { patch: change.patch, reflection });
        message = `Updated: ${summarize(change)}.`;
        break;
      }
      case 'start_pass': {
        const rule = st.getRule(change.rule);
        if (!rule) return fail('not_found', `${change.rule.target} is no longer blocked`);
        const decision = this.passDecision(rule, now);
        if (!decision.ok) return fail('limit_reached', decision.reason);
        const endsAt = now + decision.grant.durationMs;
        st.addPass({
          kind: rule.kind,
          target: rule.target,
          dayKey: this.dayKey(now),
          startsAt: now,
          endsAt,
          uid,
        });
        st.recordEvent('pass_started', now, uid, {
          rule: change.rule,
          minutes: decision.grant.durationMs / 60_000,
          reflection,
        });
        message = `Pass started on ${rule.target} for ${formatDuration(decision.grant.durationMs)}. It ends at ${new Date(endsAt).toISOString()}.`;
        break;
      }
    }
    const f = await this.applyForClient('saved the change but could not apply it');
    return f ?? { ok: true, value: message };
  }

  // ---- pending changes --------------------------------------------------------------------

  listPending(): PendingView[] {
    return this.pending.list();
  }

  cancelPending(id: number, uid: number | null) {
    return this.serial(async () => this.pending.cancel(id, uid));
  }

  challengeFor(id: number) {
    return this.serial(
      async (): Promise<Res<{ challenge: PublicChallenge; attemptsLeft: number }>> =>
        this.pending.challenge(id),
    );
  }

  answer(id: number, response: string, uid: number | null) {
    return this.serial(
      async (): Promise<
        Res<{ result: 'applied'; message: string } | Extract<AnswerResult, { status: 'wrong' }>>
      > => {
        const r = this.pending.answer(id, response);
        if (!r.ok) return r;
        if (r.value.status === 'wrong') return { ok: true, value: r.value };
        const { row, reflection } = r.value;
        const change = this.pending.change(row);
        const done = await this.applyChange(change, uid, reflection);
        const now = this.now();
        if (!done.ok && done.code !== 'internal') {
          // The world changed while waiting (rule removed, pass limit used up): the request is moot.
          this.deps.store.resolvePending(id, 'cancelled', now);
          this.deps.store.recordEvent('change_cancelled', now, uid, { id, reason: done.message });
          return done;
        }
        this.deps.store.resolvePending(id, 'applied', now);
        this.deps.store.recordEvent('change_applied', now, uid, {
          id,
          kind: row.kind,
          summary: row.summary,
          requestedBy: row.requestedByUid,
          reflection,
        });
        if (!done.ok) return done;
        return { ok: true, value: { result: 'applied', message: done.value } };
      },
    );
  }

  // ---- views ------------------------------------------------------------------------------

  status(): EngineStatus {
    const { store, dryRun } = this.deps;
    const now = this.now();
    return {
      ruleCount: store.listRules().length,
      blockedDomainCount: this.desiredDomains(now).length,
      lastReconcileAt: this.lastReconcileAt,
      tamperCount: store.countEvents('tamper'),
      lastTamperAt: store.lastEventTs('tamper'),
      pendingCount: this.pending.list().length,
      passesUsedToday: store.passesOnDay(this.dayKey(now)).length,
      passesPerDay: this.settings().passesPerDay,
      dryRun,
    };
  }

  list(): { rules: RuleDetail[]; blockedDomains: string[] } {
    const now = this.now();
    const blocking = new Set(this.blockingRules(now).map(ruleKey));
    return {
      rules: this.deps.store.listRules().map((r) => ({
        kind: r.kind,
        target: r.target,
        createdAt: r.createdAt,
        schedule: r.schedule === null ? null : toWire(r.schedule),
        scheduleText: describeSchedule(r.schedule),
        dailyLimitMinutes: r.dailyLimitMinutes,
        blockingNow: blocking.has(ruleKey(r)),
        passEndsAt: this.runningPass(r, now)?.endsAt ?? null,
      })),
      blockedDomains: this.desiredDomains(now),
    };
  }
}

function toRule(r: StoredRule): Rule {
  return { kind: r.kind, target: r.target };
}

function toWire(s: NonNullable<StoredRule['schedule']>): ScheduleWire {
  const d = s.days;
  const w = (x: readonly { start: number; end: number }[]) =>
    x.map((y) => ({ start: y.start, end: y.end }));
  return {
    timezone: s.timezone,
    days: {
      mon: w(d.mon),
      tue: w(d.tue),
      wed: w(d.wed),
      thu: w(d.thu),
      fri: w(d.fri),
      sat: w(d.sat),
      sun: w(d.sun),
    },
  };
}

function makeScheduleFromWire(w: ScheduleWire): Result<WeeklySchedule> {
  return makeSchedule(w.timezone, w.days);
}
