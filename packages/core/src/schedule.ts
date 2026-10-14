import { err, ok, type Result } from './result.js';

/** Weekdays, Monday first. The index is used throughout (0 = Monday). */
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export const MINUTES_PER_DAY = 1440;
const MAX_WINDOWS_PER_DAY = 24;

/** Half-open range of minutes since local midnight: `start <= m < end`, `end <= 1440`. */
export interface Window {
  readonly start: number;
  readonly end: number;
}

/**
 * When a rule is blocking: per weekday, a list of windows, evaluated in `timezone`.
 * Windows are normalised (sorted, merged, within the day). A day with no windows is not
 * blocking. A rule with no schedule at all is always blocking.
 */
export interface WeeklySchedule {
  readonly timezone: string;
  readonly days: Readonly<Record<Day, readonly Window[]>>;
}

export function isValidTimezone(tz: string): boolean {
  if (tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalTime {
  readonly day: Day;
  /** Minutes since local midnight, 0..1439. */
  readonly minute: number;
  /** Local calendar date, `YYYY-MM-DD`. */
  readonly dateKey: string;
}

/** Wall-clock weekday, minute and date of `instant` (epoch ms) in `tz`. */
export function localTime(instant: number, tz: string): LocalTime {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = get('weekday').slice(0, 3).toLowerCase() as Day;
  if (!DAYS.includes(day)) throw new Error(`cannot read weekday for ${tz}`);
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return { day, minute, dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}

/** Local calendar date key (`YYYY-MM-DD`) of `instant` in `tz`. Used for "per day" counting. */
export function dateKey(instant: number, tz: string): string {
  return localTime(instant, tz).dateKey;
}

/** Sort, merge touching or overlapping windows and validate bounds. */
export function normalizeWindows(windows: readonly Window[]): Result<Window[]> {
  for (const w of windows) {
    if (!Number.isInteger(w.start) || !Number.isInteger(w.end))
      return err('window times must be whole minutes');
    if (w.start < 0 || w.end > MINUTES_PER_DAY || w.start >= w.end) {
      return err(`invalid window ${formatMinute(w.start)}-${formatMinute(w.end)}`);
    }
  }
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end)
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, w.end) };
    else out.push({ start: w.start, end: w.end });
  }
  if (out.length > MAX_WINDOWS_PER_DAY)
    return err(`at most ${MAX_WINDOWS_PER_DAY} windows per day`);
  return ok(out);
}

/** Build a validated schedule from per-day windows. Unlisted days are empty. */
export function makeSchedule(
  timezone: string,
  days: Partial<Record<Day, readonly Window[]>>,
): Result<WeeklySchedule> {
  if (!isValidTimezone(timezone)) return err(`unknown timezone "${timezone}"`);
  const out = {} as Record<Day, readonly Window[]>;
  for (const d of DAYS) {
    const n = normalizeWindows(days[d] ?? []);
    if (!n.ok) return err(`${d}: ${n.error}`);
    out[d] = n.value;
  }
  return ok({ timezone, days: out });
}

/** Whether a rule with this schedule is blocking at `instant`. `null` means always. */
export function isActive(schedule: WeeklySchedule | null, instant: number): boolean {
  if (schedule === null) return true;
  const t = localTime(instant, schedule.timezone);
  return schedule.days[t.day].some((w) => t.minute >= w.start && t.minute < w.end);
}

/** One flag per minute of the week, Monday 00:00 first. */
export function toGrid(schedule: WeeklySchedule | null): Uint8Array {
  const grid = new Uint8Array(7 * MINUTES_PER_DAY);
  if (schedule === null) return grid.fill(1);
  DAYS.forEach((d, i) => {
    for (const w of schedule.days[d])
      grid.fill(1, i * MINUTES_PER_DAY + w.start, i * MINUTES_PER_DAY + w.end);
  });
  return grid;
}

/** True if no minute of the week is left unblocked. */
export function isAlwaysOn(schedule: WeeklySchedule | null): boolean {
  return schedule === null || toGrid(schedule).every((v) => v === 1);
}

/**
 * Does replacing `from` with `to` loosen protection, i.e. is any minute that was blocking
 * no longer blocking? Exact per-minute comparison. A timezone change counts as loosening
 * unless both sides block around the clock, since it shifts every window.
 */
export function loosensSchedule(from: WeeklySchedule | null, to: WeeklySchedule | null): boolean {
  if (isAlwaysOn(from) && isAlwaysOn(to)) return false;
  if (from !== null && to !== null && from.timezone !== to.timezone) return true;
  const a = toGrid(from);
  const b = toGrid(to);
  return a.some((v, i) => v === 1 && b[i] === 0);
}

/** Same blocking minutes and timezone (or both always-on). */
export function scheduleEquals(a: WeeklySchedule | null, b: WeeklySchedule | null): boolean {
  if (isAlwaysOn(a) && isAlwaysOn(b)) return true;
  if (a === null || b === null || a.timezone !== b.timezone) return false;
  const ga = toGrid(a);
  const gb = toGrid(b);
  return ga.every((v, i) => v === gb[i]);
}

export function formatMinute(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Human-readable summary, e.g. `mon-fri 09:00-17:00; sat 10:00-12:00 (Asia/Kolkata)`. */
export function describeSchedule(schedule: WeeklySchedule | null): string {
  if (schedule === null) return 'always';
  const perDay = DAYS.map((d) =>
    schedule.days[d].map((w) => `${formatMinute(w.start)}-${formatMinute(w.end)}`).join(','),
  );
  const groups: { from: number; to: number; text: string }[] = [];
  perDay.forEach((text, i) => {
    if (text === '') return;
    const last = groups[groups.length - 1];
    if (last && last.to === i - 1 && last.text === text) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  if (groups.length === 0) return `never (${schedule.timezone})`;
  const body = groups
    .map((g) => `${g.from === g.to ? DAYS[g.from] : `${DAYS[g.from]}-${DAYS[g.to]}`} ${g.text}`)
    .join('; ');
  return `${body} (${schedule.timezone})`;
}

const DAY_ALIASES: Record<string, readonly Day[]> = {
  daily: DAYS,
  everyday: DAYS,
  all: DAYS,
  weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  weekends: ['sat', 'sun'],
};
const FULL_NAMES: Record<string, Day> = {
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sun: 'sun',
  sunday: 'sun',
};

function parseDayToken(token: string): Result<Day[]> {
  const alias = DAY_ALIASES[token];
  if (alias) return ok([...alias]);
  const range = /^([a-z]+)-([a-z]+)$/.exec(token);
  if (range) {
    const a = FULL_NAMES[range[1] as string];
    const b = FULL_NAMES[range[2] as string];
    if (!a || !b) return err(`unknown day in "${token}"`);
    const out: Day[] = [];
    let i = DAYS.indexOf(a);
    const end = DAYS.indexOf(b);
    for (;;) {
      out.push(DAYS[i] as Day);
      if (i === end) break;
      i = (i + 1) % 7; // "fri-mon" wraps over the weekend
    }
    return ok(out);
  }
  const single = FULL_NAMES[token];
  return single ? ok([single]) : err(`unknown day "${token}"`);
}

function parseTime(text: string, allow24: boolean): Result<number> {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return err(`time must look like 09:30, got "${text}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return err(`invalid minutes in "${text}"`);
  if (h === 24 && min === 0 && allow24) return ok(MINUTES_PER_DAY);
  if (h > 23) return err(`invalid hour in "${text}"`);
  return ok(h * 60 + min);
}

/**
 * Parse specs like `mon-fri 09:00-17:00`, `sat,sun 10:00-12:00`, `daily 22:00-02:00`
 * (overnight windows continue into the next day) into a schedule.
 */
export function parseScheduleSpec(
  specs: readonly string[],
  timezone: string,
): Result<WeeklySchedule> {
  if (specs.length === 0) return err('give at least one window, for example "mon-fri 09:00-17:00"');
  const days: Record<Day, Window[]> = {
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
  for (const raw of specs) {
    const spec = raw.trim().toLowerCase();
    const m = /^(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(spec);
    if (!m) return err(`cannot read "${raw}". Expected like "mon-fri 09:00-17:00"`);
    const targetDays: Day[] = [];
    for (const token of (m[1] as string).split(',')) {
      const d = parseDayToken(token);
      if (!d.ok) return d;
      targetDays.push(...d.value);
    }
    const start = parseTime(m[2] as string, false);
    if (!start.ok) return start;
    const end = parseTime(m[3] as string, true);
    if (!end.ok) return end;
    let to = end.value;
    if (to === 0) to = MINUTES_PER_DAY; // "22:00-00:00" means until midnight
    if (to === start.value) return err(`empty window in "${raw}"`);
    for (const d of targetDays) {
      if (to > start.value) days[d].push({ start: start.value, end: to });
      else {
        // overnight: the rest of today and the start of tomorrow
        days[d].push({ start: start.value, end: MINUTES_PER_DAY });
        const next = DAYS[(DAYS.indexOf(d) + 1) % 7] as Day;
        days[next].push({ start: 0, end: to });
      }
    }
  }
  return makeSchedule(timezone, days);
}
