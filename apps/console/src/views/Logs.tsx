import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventSeverity, SystemEvent } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { useAtlas } from '../store.ts';
import { Empty, ErrorNote, Panel, SeverityChip, Spinner, relativeTime } from '../components/ui.tsx';

const SEVERITIES: EventSeverity[] = ['info', 'success', 'warning', 'error', 'critical'];

/**
 * The activity log (SRS §2.14).
 *
 * Live events stream in over the socket; the historical view is fetched. Both
 * are merged and de-duplicated so the list never shows the same event twice.
 */
export function LogsView() {
  const feed = useAtlas((s) => s.feed);
  const connect = useAtlas((s) => s.connect);

  const [history, setHistory] = useState<SystemEvent[] | null>(null);
  const [severity, setSeverity] = useState<EventSeverity | ''>('');
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    connect(['event', 'stats']);
  }, [connect]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      setHistory(await api.events({ severity: severity || undefined, limit: 200 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the event log');
      setHistory([]);
    }
  }, [severity]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = useMemo(() => {
    const merged = new Map<string, SystemEvent>();
    if (live) for (const event of feed) merged.set(event.id, event);
    for (const event of history ?? []) merged.set(event.id, event);

    return [...merged.values()]
      .filter((event) => (severity ? event.severity === severity : true))
      .filter((event) =>
        search
          ? `${event.message} ${event.type} ${event.source}`.toLowerCase().includes(search.toLowerCase())
          : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 400);
  }, [feed, history, live, severity, search]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Activité</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            Everything ATLAS has done, in order. Nothing important happens without appearing here.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[--color-muted]">
          <input
            type="checkbox"
            className="size-4 accent-sky-500"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          Suivre en direct
        </label>
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          className="input max-w-md"
          placeholder="Filtrer par message, type ou source…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input max-w-40"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as EventSeverity | '')}
        >
          <option value="">Toutes les sévérités</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
        <span className="ml-auto self-center text-xs text-[--color-faint]">{events.length} event(s)</span>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel dense>
        {history === null ? (
          <Spinner />
        ) : events.length === 0 ? (
          <Empty icon="≡" title="Aucun événement ne correspond" />
        ) : (
          <ul className="divide-y divide-[--color-border]">
            {events.map((event) => (
              <li key={event.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-[--color-surface]">
                <span className="w-20 shrink-0 pt-0.5 text-[0.68rem] text-[--color-faint]">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
                <SeverityChip severity={event.severity} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[--color-ink]">{event.message}</div>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[0.68rem] text-[--color-faint]">
                    <span className="font-mono">{event.type}</span>
                    <span>· {event.source}</span>
                    {event.agentKey && <span>· {event.agentKey}</span>}
                    <span>· {relativeTime(event.createdAt)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
