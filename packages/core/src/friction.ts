import { isValidTimezone } from './schedule.js';
import { err, ok, type Result } from './result.js';

/** The kinds of change that go through the friction flow when they loosen protection. */
export type ChangeKind =
  'remove_rule' | 'set_schedule' | 'set_limit' | 'set_setting' | 'start_pass';

/** How long after the cooldown ends a pending change can still be confirmed. */
export const CHALLENGE_WINDOW_MS = 30 * 60_000;
/** Wrong answers allowed per challenge before a fresh one is issued. */
export const MAX_ATTEMPTS = 3;

export interface PendingTimes {
  readonly requestedAt: number;
  readonly cooldownEndsAt: number;
  readonly expiresAt: number;
}

/** Times for a change requested at `now` with the given cooldown (0 for passes). */
export function planTimes(now: number, cooldownMs: number): PendingTimes {
  return {
    requestedAt: now,
    cooldownEndsAt: now + cooldownMs,
    expiresAt: now + cooldownMs + CHALLENGE_WINDOW_MS,
  };
}

/** `cooldown`: wait. `ready`: a challenge may be taken. `expired`: too late, request again. */
export type PendingPhase = 'cooldown' | 'ready' | 'expired';

export function phaseOf(t: PendingTimes, now: number): PendingPhase {
  if (now >= t.expiresAt) return 'expired';
  return now < t.cooldownEndsAt ? 'cooldown' : 'ready';
}

export type Direction = 'tighten' | 'loosen' | 'same';

/** `null` means no limit, the loosest value. */
export function compareLimit(from: number | null, to: number | null): Direction {
  if (from === to) return 'same';
  if (to === null) return 'loosen';
  if (from === null) return 'tighten';
  return to < from ? 'tighten' : 'loosen';
}

// ---- settings -------------------------------------------------------------------------

export interface Settings {
  readonly cooldownSeconds: number;
  readonly passesPerDay: number;
  readonly passMinutes: number;
  /** IANA zone used for "per day" counting and as the default for new schedules. */
  readonly timezone: string;
}

export const SETTING_KEYS = ['cooldown', 'passes-per-day', 'pass-minutes', 'timezone'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Owner-approved defaults: 10 minute cooldown, 3 passes of 15 minutes per day. */
export const DEFAULT_SETTINGS: Omit<Settings, 'timezone'> = {
  cooldownSeconds: 10 * 60,
  passesPerDay: 3,
  passMinutes: 15,
};

function wholeNumber(text: string, min: number, max: number, what: string): Result<number> {
  if (!/^\d+$/.test(text.trim())) return err(`${what} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) return err(`${what} must be between ${min} and ${max}`);
  return ok(n);
}

/** Parse a user-supplied setting value into a patch. Units: minutes, counts, an IANA zone. */
export function parseSetting(key: string, value: string): Result<Partial<Settings>> {
  switch (key) {
    case 'cooldown': {
      const n = wholeNumber(value, 1, 720, 'cooldown (minutes)');
      return n.ok ? ok({ cooldownSeconds: n.value * 60 }) : n;
    }
    case 'passes-per-day': {
      const n = wholeNumber(value, 0, 24, 'passes-per-day');
      return n.ok ? ok({ passesPerDay: n.value }) : n;
    }
    case 'pass-minutes': {
      const n = wholeNumber(value, 1, 180, 'pass-minutes');
      return n.ok ? ok({ passMinutes: n.value }) : n;
    }
    case 'timezone':
      return isValidTimezone(value.trim())
        ? ok({ timezone: value.trim() })
        : err(`unknown timezone "${value}"`);
    default:
      return err(`unknown setting "${key}". Known: ${SETTING_KEYS.join(', ')}`);
  }
}

/** Is applying `patch` on top of `current` tighter, looser or no change? Any loosening field wins. */
export function compareSettings(current: Settings, patch: Partial<Settings>): Direction {
  let tighter = false;
  let looser = false;
  const mark = (d: Direction): void => {
    if (d === 'tighten') tighter = true;
    if (d === 'loosen') looser = true;
  };
  const num = (from: number, to: number | undefined, higherIsLooser: boolean): void => {
    if (to === undefined || to === from) return;
    mark(higherIsLooser === to > from ? 'loosen' : 'tighten');
  };
  num(current.cooldownSeconds, patch.cooldownSeconds, false); // shorter cooldown loosens
  num(current.passesPerDay, patch.passesPerDay, true);
  num(current.passMinutes, patch.passMinutes, true);
  if (patch.timezone !== undefined && patch.timezone !== current.timezone) mark('loosen'); // shifts every window
  if (looser) return 'loosen';
  return tighter ? 'tighten' : 'same';
}

/** The setting as the user thinks of it, for messages. */
export function describeSetting(key: SettingKey, s: Settings): string {
  switch (key) {
    case 'cooldown':
      return `${s.cooldownSeconds / 60} minutes`;
    case 'passes-per-day':
      return String(s.passesPerDay);
    case 'pass-minutes':
      return `${s.passMinutes} minutes`;
    case 'timezone':
      return s.timezone;
  }
}

// ---- passes ---------------------------------------------------------------------------

/** A pass as the accounting rules see it. */
export interface PassLike {
  /** `kind:target` of the rule it suspended. */
  readonly ruleKey: string;
  /** Local date key (`YYYY-MM-DD`) the pass started on. */
  readonly dayKey: string;
  readonly startsAt: number;
  readonly endsAt: number;
  /** Set when ended early. */
  readonly endedAt: number | null;
}

/** Milliseconds a pass has actually been in force at `now`. */
export function passElapsedMs(p: PassLike, now: number): number {
  const end = Math.min(p.endedAt ?? p.endsAt, p.endsAt, now);
  return Math.max(0, end - p.startsAt);
}

export interface PassGrant {
  readonly durationMs: number;
}

export type PassDecision =
  | { readonly ok: true; readonly grant: PassGrant }
  | { readonly ok: false; readonly reason: string };

const MIN_PASS_MS = 60_000;

/**
 * May a pass for `ruleKey` start now, and for how long? Limits, in order: passes per day
 * (all rules, early-ended ones still count), then the rule's daily limit in pass minutes
 * (actual minutes used). The grant is trimmed to what is left of the rule's limit.
 */
export function decidePass(args: {
  readonly passes: readonly PassLike[];
  readonly ruleKey: string;
  readonly dayKey: string;
  readonly now: number;
  readonly settings: Settings;
  /** Max pass minutes per day for this rule, or null for no per-rule limit. */
  readonly ruleLimitMinutes: number | null;
}): PassDecision {
  const { passes, ruleKey, dayKey, now, settings, ruleLimitMinutes } = args;
  const today = passes.filter((p) => p.dayKey === dayKey);
  if (today.length >= settings.passesPerDay) {
    return {
      ok: false,
      reason:
        settings.passesPerDay === 0
          ? 'passes are turned off (passes-per-day is 0)'
          : `you have used all ${settings.passesPerDay} passes for today`,
    };
  }
  let durationMs = settings.passMinutes * 60_000;
  if (ruleLimitMinutes !== null) {
    const usedMs = today
      .filter((p) => p.ruleKey === ruleKey)
      .reduce((sum, p) => sum + passElapsedMs(p, now), 0);
    const leftMs = ruleLimitMinutes * 60_000 - usedMs;
    if (leftMs < MIN_PASS_MS) {
      return {
        ok: false,
        reason:
          ruleLimitMinutes === 0
            ? 'this rule allows no passes (daily limit is 0)'
            : `the daily limit of ${ruleLimitMinutes} minutes for this rule is used up`,
      };
    }
    durationMs = Math.min(durationMs, Math.floor(leftMs / MIN_PASS_MS) * MIN_PASS_MS);
  }
  return { ok: true, grant: { durationMs } };
}
