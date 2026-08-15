import { useCallback, useEffect, useState } from 'react';
import type { MemoryHit, MemoryTier } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { Empty, ErrorNote, Panel, Spinner, StatCard, relativeTime } from '../components/ui.tsx';

const TIER_LABEL: Record<MemoryTier, string> = {
  operational: 'Operational — current missions',
  strategic: 'Strategic — how ATLAS works best',
  business: 'Business — market and entity knowledge',
};

const TIER_TONE: Record<MemoryTier, string> = {
  operational: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
  strategic: 'border-violet-500/25 bg-violet-500/10 text-violet-300',
  business: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
};

/** The Central Library (SRS §2.11): what ATLAS knows, and how it is organised. */
export function MemoryView() {
  const [items, setItems] = useState<MemoryHit[] | null>(null);
  const [stats, setStats] = useState<{ total: number; byTier: Record<string, number> } | null>(null);
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState<MemoryTier | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const result = await api.memory({ q: query || undefined, tier: tier || undefined, limit: 40 });
      setItems(result.items);
      setStats(result.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not search memory');
      setItems([]);
    }
  }, [query, tier]);

  useEffect(() => {
    // Debounce so typing does not fire a query per keystroke.
    const timer = setTimeout(() => void load(), query ? 280 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  const consolidate = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.consolidateMemory();
      await load();
      setError(
        `Consolidation complete — ${result.promoted} promoted, ${result.expired} expired, ${result.pruned} pruned.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const forget = async (id: string): Promise<void> => {
    await api.forgetMemory(id);
    await load();
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Mémoire</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            Everything ATLAS has learned. Agents search this before researching anything new.
          </p>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => void consolidate()}>
          {busy ? 'Consolidating…' : 'Consolidate now'}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Connaissances totales" value={stats?.total ?? '—'} />
        <StatCard label="Operational" value={stats?.byTier.operational ?? 0} tone="atlas" />
        <StatCard label="Strategic" value={stats?.byTier.strategic ?? 0} tone="arcane" />
        <StatCard label="Business" value={stats?.byTier.business ?? 0} tone="ember" />
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className="input max-w-md"
          placeholder="Rechercher dans ce qu’ATLAS sait…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="input max-w-56" value={tier} onChange={(e) => setTier(e.target.value as MemoryTier | '')}>
          <option value="">Tous les niveaux</option>
          {(Object.keys(TIER_LABEL) as MemoryTier[]).map((t) => (
            <option key={t} value={t}>
              {TIER_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorNote message={error} />}

      <Panel dense>
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty
            icon="❖"
            title={query ? 'Nothing matches that search' : 'The library is empty'}
            hint={
              query
                ? 'Try broader terms — recall matches on any word.'
                : 'ATLAS records knowledge as missions complete. Run one to begin filling the library.'
            }
          />
        ) : (
          <ul className="divide-y divide-[--color-border]">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`chip border ${TIER_TONE[item.tier]}`}>{item.tier}</span>
                      <span className="chip border border-[--color-border] text-[--color-faint]">
                        {item.kind}
                      </span>
                      {item.tags.map((tag) => (
                        <span key={tag} className="chip border border-[--color-border] text-[--color-faint]">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <h3 className="mt-1.5 text-sm font-medium text-[--color-ink]">{item.title}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[--color-muted]">
                      {item.content.length > 600 ? `${item.content.slice(0, 600)}…` : item.content}
                    </p>
                    <div className="mt-1.5 text-[0.68rem] text-[--color-faint]">
                      importance {(item.importance * 100).toFixed(0)}% · recalled {item.accessCount}× ·{' '}
                      {relativeTime(item.createdAt)}
                      {item.agentKey && ` · by ${item.agentKey}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-[--color-faint] hover:text-rose-300"
                    onClick={() => void forget(item.id)}
                  >
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
