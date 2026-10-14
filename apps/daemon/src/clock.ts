import * as fs from 'node:fs';

/**
 * Milliseconds since boot including time spent suspended (Linux CLOCK_BOOTTIME, read from
 * /proc/uptime). It does not follow the wall clock, so comparing it with `Date.now()`
 * reveals the clock being set. Falls back to the process monotonic clock where unreadable.
 */
export function bootClockMs(): number {
  try {
    const first = fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0];
    const seconds = Number(first);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  } catch {
    /* not Linux, or /proc not mounted */
  }
  return Math.round(performance.now());
}
