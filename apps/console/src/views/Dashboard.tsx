import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Mission } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { useAtlas } from '../store.ts';
import {
  Empty,
  MissionStatusChip,
  Panel,
  ProgressBar,
  Spinner,
  StatCard,
  formatNumber,
  relativeTime,
} from '../components/ui.tsx';
import { NewMissionDialog } from '../components/NewMissionDialog.tsx';

/** The founder's landing view: state of the organisation in one screen. */
export function DashboardView() {
  const navigate = useNavigate();
  const { stats, health, feed, mode } = useAtlas();
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  /**
   * Crée la mission de démonstration et ouvre sa fiche.
   *
   * Le serveur décide si elle est permise ; en cas de refus on montre son motif
   * tel quel, plutôt que de le reformuler en quelque chose de rassurant.
   */
  const startDemo = async (): Promise<void> => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      const mission = await api.createDemoMission();
      navigate(`/missions/${mission.id}`);
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const page = await api.missions({ limit: 6 });
        if (!cancelled) setMissions(page.items);
      } catch {
        if (!cancelled) setMissions([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const activity = feed.filter((e) => e.severity !== 'debug').slice(0, 12);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Command Center</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            Votre organisation numérique en un écran. Donnez une direction — Hermès organise le reste.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
          + Nouvelle mission
        </button>
      </header>

      {mode === 'simulation' && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p className="min-w-0 flex-1">
            <strong className="font-semibold">Mode simulation.</strong> ATLAS fonctionne entièrement —
            planification, assignation, mémoire, évolution — mais les agents n’ont accès à aucune donnée
            externe : leurs conclusions sont des jalons de structure, pas des faits. Aucun appel n’est
            facturé.
          </p>
          <button
            type="button"
            className="btn shrink-0 !border-amber-500/40 !text-amber-100"
            disabled={demoBusy}
            onClick={() => void startDemo()}
            title="Crée et démarre la mission DEMO — Business Expansion"
          >
            {demoBusy ? 'Démarrage…' : '▶ Lancer la mission de démonstration'}
          </button>
        </div>
      )}

      {demoError && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {demoError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Missions en cours"
          value={stats?.missions.active ?? '—'}
          hint={`${stats?.missions.total ?? 0} au total`}
        />
        <StatCard
          label="Terminées aujourd’hui"
          value={stats?.missions.completedToday ?? '—'}
          hint={`${stats?.missions.successRate ?? 100} % de réussite`}
          tone="vital"
        />
        <StatCard
          label="Agents au travail"
          value={stats?.agents.active ?? '—'}
          hint={`${stats?.agents.available ?? 0} disponibles`}
          tone="ember"
        />
        <StatCard
          label="Connaissances"
          value={formatNumber(stats?.memory.total ?? 0)}
          hint="éléments en mémoire"
          tone="arcane"
        />
        <StatCard
          label="Jetons aujourd’hui"
          value={formatNumber(stats?.tokens.today ?? 0)}
          hint={`${formatNumber(stats?.tokens.total ?? 0)} depuis l’origine`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        <Panel
          title="Missions récentes"
          action={
            <Link to="/missions" className="text-xs text-[--color-atlas] hover:underline">
              Tout voir →
            </Link>
          }
          dense
        >
          {missions === null ? (
            <Spinner />
          ) : missions.length === 0 ? (
            <Empty
              icon="▶"
              title="Aucune mission pour l’instant"
              hint="Donnez un objectif à ATLAS et regardez l’organisation s’en saisir."
            />
          ) : (
            <ul className="divide-y divide-[--color-border]">
              {missions.map((mission) => (
                <li key={mission.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/missions/${mission.id}`)}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-[--color-surface]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[0.7rem] text-[--color-faint]">{mission.code}</span>
                          <MissionStatusChip status={mission.status} />
                        </div>
                        <div className="mt-1 truncate text-sm font-medium text-[--color-ink]">
                          {mission.title}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-[--color-faint]">
                        {relativeTime(mission.createdAt)}
                      </span>
                    </div>
                    {['running', 'planned', 'assigned'].includes(mission.status) && (
                      <div className="mt-2">
                        <ProgressBar value={mission.progress} />
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title="Santé du système" dense>
            {!health ? (
              <Spinner />
            ) : (
              <ul className="divide-y divide-[--color-border]">
                {health.checks.map((check) => (
                  <li key={check.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`size-2 rounded-full ${
                          check.status === 'pass'
                            ? 'bg-emerald-400'
                            : check.status === 'warn'
                              ? 'bg-amber-400'
                              : 'bg-rose-400'
                        }`}
                      />
                      <span className="text-sm capitalize text-[--color-ink]">{check.name}</span>
                    </div>
                    <span className="truncate text-right text-xs text-[--color-faint]">{check.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Activité en direct"
            action={
              <Link to="/logs" className="text-xs text-[--color-atlas] hover:underline">
                Journal complet →
              </Link>
            }
            dense
          >
            {activity.length === 0 ? (
              <Empty icon="≡" title="Calme pour l’instant" hint="Les événements apparaissent ici à l’instant où ils se produisent." />
            ) : (
              <ul className="max-h-[22rem] divide-y divide-[--color-border] overflow-y-auto">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-start gap-2.5 px-4 py-2.5 animate-rise">
                    <span
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        event.severity === 'error' || event.severity === 'critical'
                          ? 'bg-rose-400'
                          : event.severity === 'warning'
                            ? 'bg-amber-400'
                            : event.severity === 'success'
                              ? 'bg-emerald-400'
                              : 'bg-sky-400'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-[--color-ink]">{event.message}</div>
                      <div className="mt-0.5 text-[0.68rem] text-[--color-faint]">
                        {event.source} · {relativeTime(event.createdAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {dialogOpen && (
        <NewMissionDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(mission) => {
            setDialogOpen(false);
            navigate(`/missions/${mission.id}`);
          }}
        />
      )}
    </div>
  );
}
