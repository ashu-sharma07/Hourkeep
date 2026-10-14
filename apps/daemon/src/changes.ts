import { describeSchedule, type Rule, type Settings, type WeeklySchedule } from '@hourkeep/core';

/** A requested change to protection state. This is also the stored payload of a pending change. */
export type Change =
  | { readonly kind: 'remove_rule'; readonly rule: Rule }
  | { readonly kind: 'set_schedule'; readonly rule: Rule; readonly schedule: WeeklySchedule | null }
  | { readonly kind: 'set_limit'; readonly rule: Rule; readonly minutes: number | null }
  | { readonly kind: 'set_setting'; readonly patch: Partial<Settings> }
  | { readonly kind: 'start_pass'; readonly rule: Rule };

/** The change as a verb phrase: it finishes "Why do you want to ...?" and "You are about to ...". */
export function summarize(change: Change): string {
  switch (change.kind) {
    case 'remove_rule':
      return `stop blocking ${change.rule.target}`;
    case 'set_schedule':
      return `change the schedule of ${change.rule.target} to ${describeSchedule(change.schedule)}`;
    case 'set_limit':
      return change.minutes === null
        ? `remove the daily limit of ${change.rule.target}`
        : `set the daily limit of ${change.rule.target} to ${change.minutes} minutes`;
    case 'set_setting': {
      const p = change.patch;
      const parts: string[] = [];
      if (p.cooldownSeconds !== undefined)
        parts.push(`set the cooldown to ${p.cooldownSeconds / 60} minutes`);
      if (p.passesPerDay !== undefined) parts.push(`allow ${p.passesPerDay} passes per day`);
      if (p.passMinutes !== undefined) parts.push(`make passes ${p.passMinutes} minutes long`);
      if (p.timezone !== undefined) parts.push(`change the timezone to ${p.timezone}`);
      return parts.join(' and ') || 'change settings';
    }
    case 'start_pass':
      return `use a temporary pass on ${change.rule.target}`;
  }
}

/** Stable text for comparing two changes (used to avoid duplicate pending requests). */
export function changeKey(change: Change): string {
  return JSON.stringify(change);
}

/** "4m 12s", "45s", "1h 5m": for messages about time left. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
