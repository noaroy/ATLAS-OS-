/** Time helpers. All persisted timestamps are ISO-8601 UTC strings. */

export const nowIso = (): string => new Date().toISOString();

export const isoFrom = (ms: number): string => new Date(ms).toISOString();

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function durationSince(startIso: string | null): number {
  if (!startIso) return 0;
  return Math.max(0, Date.now() - Date.parse(startIso));
}

/** Compact human duration, e.g. `2m 14s`. Used in logs and the console. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const startOfTodayIso = (): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

export const addMs = (iso: string, ms: number): string => isoFrom(Date.parse(iso) + ms);
