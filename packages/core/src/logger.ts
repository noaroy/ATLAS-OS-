import { nowIso } from './time.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR: Record<LogLevel, string> = {
  debug: '[90m',
  info: '[36m',
  warn: '[33m',
  error: '[31m',
};
const RESET = '[0m';
const DIM = '[2m';

export interface LoggerOptions {
  level: LogLevel;
  pretty: boolean;
  /** Fields attached to every line from this logger. */
  bindings?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Derives a logger that carries additional context on every line. */
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Structured logger: JSON in production (so a VPS log shipper can parse it),
 * colourised single lines in development.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: Record<string, unknown> = {
      time: nowIso(),
      level,
      message,
      ...bindings,
      ...fields,
    };

    if (!options.pretty) {
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(JSON.stringify(record, replacer) + '\n');
      return;
    }

    const time = String(record.time);
    const scope = typeof record.scope === 'string' ? `${DIM}[${record.scope}]${RESET} ` : '';
    const extras = Object.entries({ ...bindings, ...fields })
      .filter(([k]) => k !== 'scope')
      .map(([k, v]) => `${DIM}${k}=${RESET}${format(v)}`)
      .join(' ');
    const line = `${DIM}${time.slice(11, 23)}${RESET} ${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET} ${scope}${message}${extras ? ' ' + extras : ''}`;
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

function format(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** Keeps Errors and BigInts from silently disappearing from JSON logs. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Fallback logger for code paths that run before configuration is loaded. */
export const bootLogger: Logger = createLogger({ level: 'info', pretty: true, bindings: { scope: 'boot' } });
