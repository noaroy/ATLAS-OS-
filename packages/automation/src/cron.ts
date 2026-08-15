/**
 * Minimal 5-field cron parser: `minute hour day-of-month month day-of-week`.
 *
 * Written rather than pulled in because ATLAS needs exactly one thing from a
 * cron library — "when does this next fire" — and a 120-line parser is easier
 * to reason about than a dependency in the 24/7 scheduling path.
 *
 * Supports `*`, `a-b` ranges, `a,b,c` lists, `*\/n` and `a-b/n` steps.
 * Day-of-week is 0–6 with Sunday = 0 (7 also accepted).
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the expression constrains day-of-month or day-of-week. */
  restrictsDay: { dom: boolean; dow: boolean };
}

const NAMED: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export function parseCron(expression: string): CronFields {
  const normalised = NAMED[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalised.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expression}"`);
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  return {
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    months: parseField(month, 1, 12, 'month'),
    daysOfWeek: normaliseWeekdays(parseField(dow, 0, 7, 'day-of-week')),
    restrictsDay: { dom: dom !== '*', dow: dow !== '*' },
  };
}

function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();

  for (const chunk of field.split(',')) {
    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step "${stepPart}" in ${label} field`);
    }

    let start = min;
    let end = max;

    if (rangePart && rangePart !== '*') {
      const bounds = rangePart.split('-');
      start = Number(bounds[0]);
      end = bounds.length > 1 ? Number(bounds[1]!) : start;
      // A bare `n/step` means "from n to the end of the range".
      if (bounds.length === 1 && stepPart !== undefined) end = max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid ${label} range "${chunk}" (allowed ${min}-${max})`);
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) throw new Error(`Empty ${label} field: "${field}"`);
  return values;
}

/** Cron allows both 0 and 7 for Sunday; collapse to 0. */
function normaliseWeekdays(values: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const value of values) out.add(value === 7 ? 0 : value);
  return out;
}

/**
 * Next firing time strictly after `from`, in UTC.
 *
 * Returns null if nothing matches within four years — which only happens for
 * impossible dates like `0 0 30 2 *`.
 */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const cron = parseCron(expression);

  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const limit = new Date(from.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 4);

  while (candidate <= limit) {
    if (!cron.months.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(cron, candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }

  return null;
}

/**
 * Standard cron semantics: when both day-of-month and day-of-week are
 * restricted, a day matching *either* one fires.
 */
function matchesDay(cron: CronFields, date: Date): boolean {
  const domMatch = cron.daysOfMonth.has(date.getUTCDate());
  const dowMatch = cron.daysOfWeek.has(date.getUTCDay());

  if (cron.restrictsDay.dom && cron.restrictsDay.dow) return domMatch || dowMatch;
  if (cron.restrictsDay.dom) return domMatch;
  if (cron.restrictsDay.dow) return dowMatch;
  return true;
}

/** Validates an expression without throwing — used by the API layer. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}
