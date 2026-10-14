export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** One-line key=value logs on stdout/stderr; journald adds timestamps and priorities. */
export function createLogger(min: LogLevel = 'info'): Logger {
  return {
    log(level, message, fields = {}) {
      if (ORDER[level] < ORDER[min]) return;
      const kv = Object.entries(fields)
        .map(
          ([k, v]) =>
            `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : String(v)}`,
        )
        .join(' ');
      const line = `${level.toUpperCase()} ${message}${kv ? ' ' + kv : ''}`;
      (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    },
  };
}

export const silentLogger: Logger = { log: () => undefined };
