import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Mission, MissionStatus } from '@atlas/contracts';
import { MISSION_STATUSES } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import {
  Empty,
  ErrorNote,
  MissionStatusChip,
  Panel,
  ProgressBar,
  Spinner,
  relativeTime,
} from '../components/ui.tsx';
import { NewMissionDialog } from '../components/NewMissionDialog.tsx';

const PAGE_SIZE = 25;

export function MissionsView() {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<MissionStatus | ''>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const page = await api.missions({
        limit: PAGE_SIZE,
        offset,
        status: status || undefined,
        search: search || undefined,
      });
      setMissions(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load missions');
      setMissions([]);
    }
  }, [offset, status, search]);

  useEffect(() => {
    void load();
    // Poll so a running mission's progress advances without a manual refresh.
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Missions</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            Chaque objectif confié à ATLAS, et ce qu’il en est advenu.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
          + Nouvelle mission
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Rechercher un titre, un objectif ou un code…"
          value={search}
          onChange={(e) => {
            setOffset(0);
            setSearch(e.target.value);
          }}
        />
        <select
          className="input max-w-40"
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value as MissionStatus | '');
          }}
        >
          <option value="">Tous les statuts</option>
          {MISSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-[--color-faint]">{total} mission(s)</span>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Panel dense>
        {missions === null ? (
          <Spinner />
        ) : missions.length === 0 ? (
          <Empty
            icon="▶"
            title="Aucune mission ne correspond"
            hint={search || status ? 'Try clearing the filters.' : 'Create your first mission to begin.'}
          />
        ) : (
          <ul className="divide-y divide-[--color-border]">
            {missions.map((mission) => (
              <li key={mission.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/missions/${mission.id}`)}
                  className="w-full px-4 py-3.5 text-left transition-colors hover:bg-[--color-surface]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[0.7rem] text-[--color-faint]">{mission.code}</span>
                        <MissionStatusChip status={mission.status} />
                        {mission.priority !== 'normal' && (
                          <span className="chip border border-[--color-border-bright] text-[--color-muted]">
                            {mission.priority}
                          </span>
                        )}
                        {mission.tags.map((tag) => (
                          <span key={tag} className="chip border border-[--color-border] text-[--color-faint]">
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="mt-1.5 text-sm font-medium text-[--color-ink]">{mission.title}</div>
                      <p className="mt-1 line-clamp-2 text-xs text-[--color-muted]">{mission.objective}</p>

                      {['running', 'planned', 'assigned'].includes(mission.status) && (
                        <div className="mt-2.5 max-w-md">
                          <ProgressBar value={mission.progress} />
                        </div>
                      )}
                      {mission.error && (
                        <p className="mt-1.5 text-xs text-rose-300">{mission.error}</p>
                      )}
                    </div>

                    <div className="shrink-0 text-right">
                      <div className="text-xs text-[--color-faint]">{relativeTime(mission.createdAt)}</div>
                      {mission.result && (
                        <div className="mt-1 text-xs text-[--color-muted]">
                          Quality {mission.result.quality}/100
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="btn"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            ← Précédent
          </button>
          <span className="text-xs text-[--color-faint]">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            type="button"
            className="btn"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Suivant →
          </button>
        </div>
      )}

      {dialogOpen && (
        <NewMissionDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(mission) => navigate(`/missions/${mission.id}`)}
        />
      )}
    </div>
  );
}
