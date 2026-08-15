import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Agent, Building } from '@atlas/contracts';
import { useAtlas } from '../store.ts';
import { VillageRenderer, type HitTarget } from '../village/renderer.ts';
import { AgentStatusChip, MissionStatusChip, ProgressBar, relativeTime } from '../components/ui.tsx';

/**
 * Village ATLAS — the immersive mode (SRS §3).
 *
 * The canvas carries the world; everything overlaid on it is there to answer
 * "what is happening right now" without leaving the view. Selecting an
 * inhabitant or a building opens its real record, so the village is a way into
 * the system rather than a picture of it.
 */
export function VillageView() {
  const navigate = useNavigate();
  const { village, connect, connection, mode } = useAtlas();
  const feed = useAtlas((s) => s.feed);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VillageRenderer | null>(null);
  const [selected, setSelected] = useState<HitTarget | null>(null);

  useEffect(() => {
    connect(['event', 'village', 'stats']);
  }, [connect]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new VillageRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.onSelect = setSelected;
    renderer.start();

    const onResize = (): void => renderer.resize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (village) rendererRef.current?.update(village);
  }, [village]);

  const selectedAgent = useMemo<Agent | null>(
    () => (selected?.kind === 'agent' ? (village?.agents.find((a) => a.key === selected.key) ?? null) : null),
    [selected, village],
  );

  const selectedBuilding = useMemo<Building | null>(
    () =>
      selected?.kind === 'building'
        ? (village?.buildings.find((b) => b.key === selected.key) ?? null)
        : null,
    [selected, village],
  );

  const residents = useMemo(
    () => (selectedBuilding ? (village?.agents.filter((a) => a.building === selectedBuilding.key) ?? []) : []),
    [selectedBuilding, village],
  );

  const stats = village?.stats;
  const activity = feed.filter((e) => e.severity !== 'debug').slice(0, 7);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[--color-void]">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" aria-label="Carte du village ATLAS" />

      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-5">
        <div className="pointer-events-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn !bg-black/45 backdrop-blur"
            title="Revenir au poste de commandement"
          >
            ← Poste de commandement
          </button>
          {mode === 'simulation' && (
            <span className="chip border border-amber-500/40 bg-black/50 text-amber-300 backdrop-blur">
              Mode simulation
            </span>
          )}
        </div>

        {stats && (
          <div className="pointer-events-auto flex gap-2.5">
            <VitalTile label="Population" value={stats.population} />
            <VitalTile label="Actifs" value={stats.activeAgents} tone="text-sky-300" />
            <VitalTile label="Missions du jour" value={stats.missionsToday} tone="text-emerald-300" />
            <VitalTile label="Connaissances" value={stats.knowledgeItems} tone="text-violet-300" />
            <VitalTile
              label="Vitalité"
              value={`${stats.vitality}%`}
              tone={stats.vitality > 70 ? 'text-emerald-300' : stats.vitality > 40 ? 'text-amber-300' : 'text-rose-300'}
            />
          </div>
        )}
      </div>

      {/* ── Departments ────────────────────────────────────────────────── */}
      {/*
        Every number here is counted from stored rows. A department building
        that looks busy is one where work genuinely happened — the village
        reports the organisation, it does not decorate it (Article XII).
      */}
      {village && village.departments.length > 0 && (
        <div className="pointer-events-none absolute right-5 top-24 w-64">
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/55 p-3 backdrop-blur">
            <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-[--color-faint]">
              Départements
            </span>
            <ul className="mt-2 space-y-2">
              {village.departments.map((department) => (
                <li key={department.key}>
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => rendererRef.current?.focusBuilding(department.building)}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs text-white/90">{department.name}</span>
                      {department.activeMissions > 0 && (
                        <span className="shrink-0 text-[0.62rem] text-emerald-300">
                          {department.activeMissions} active
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[0.62rem] text-[--color-faint]">
                      {department.opportunitiesDiscovered} trouvées ·{' '}
                      {department.opportunitiesShortlisted} retenues · {department.teams} teams
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── Live activity ticker ───────────────────────────────────────── */}
      <div className="pointer-events-none absolute bottom-5 left-5 w-[26rem] max-w-[38vw]">
        <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/55 p-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-[--color-faint]">
              Activité du village
            </span>
            <span className="flex items-center gap-1.5 text-[0.68rem] text-[--color-faint]">
              <span
                className={`size-1.5 rounded-full ${connection === 'live' ? 'bg-emerald-400' : 'bg-rose-400'}`}
              />
              {connection}
            </span>
          </div>

          {activity.length === 0 ? (
            <p className="py-3 text-center text-xs text-[--color-faint]">
              Le village est calme. Créez une mission pour le mettre au travail.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {activity.map((event) => (
                <li key={event.id} className="flex items-start gap-2 text-xs animate-rise">
                  <span
                    className={`mt-1 size-1.5 shrink-0 rounded-full ${
                      event.severity === 'error' || event.severity === 'critical'
                        ? 'bg-rose-400'
                        : event.severity === 'warning'
                          ? 'bg-amber-400'
                          : event.severity === 'success'
                            ? 'bg-emerald-400'
                            : 'bg-sky-400'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[--color-muted]">{event.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Camera controls ────────────────────────────────────────────── */}
      <div className="absolute bottom-5 right-5 flex flex-col gap-1.5">
        <ControlButton label="Zoom avant" onClick={() => rendererRef.current?.zoomBy(1.2)}>
          +
        </ControlButton>
        <ControlButton label="Zoom arrière" onClick={() => rendererRef.current?.zoomBy(0.83)}>
          −
        </ControlButton>
        <ControlButton label="Cadrer le village" onClick={() => rendererRef.current?.fit()}>
          ⊡
        </ControlButton>
      </div>

      {/* ── Selection panel ────────────────────────────────────────────── */}
      {(selectedAgent || selectedBuilding) && (
        <aside className="absolute right-5 top-24 w-80 animate-rise rounded-xl border border-white/10 bg-black/65 p-4 backdrop-blur-md">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="font-display text-base font-semibold">
                {selectedAgent?.name ?? selectedBuilding?.name}
              </h3>
              <p className="text-xs text-[--color-muted]">
                {selectedAgent?.role ?? selectedBuilding?.department}
              </p>
            </div>
            <button
              type="button"
              className="text-sm text-[--color-faint] hover:text-[--color-ink]"
              onClick={() => setSelected(null)}
              aria-label="Fermer le panneau"
            >
              ✕
            </button>
          </div>

          {selectedAgent && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AgentStatusChip status={selectedAgent.state.status} />
                <span className="text-xs text-[--color-faint]">
                  {relativeTime(selectedAgent.state.lastActiveAt)}
                </span>
              </div>

              <p className="text-xs leading-relaxed text-[--color-muted]">{selectedAgent.mission}</p>

              {selectedAgent.state.currentActivity && (
                <div className="rounded-lg border border-sky-500/25 bg-sky-500/10 p-2.5">
                  <div className="text-[0.65rem] uppercase tracking-wider text-sky-300">En cours</div>
                  <div className="mt-0.5 text-xs text-[--color-ink]">
                    {selectedAgent.state.currentActivity}
                  </div>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-2 text-xs">
                <Metric label="Étapes faites" value={selectedAgent.metrics.tasksSucceeded} />
                <Metric label="Réussite" value={`${selectedAgent.metrics.successRate}%`} />
                <Metric label="Qualité" value={`${selectedAgent.metrics.qualityScore}/100`} />
                <Metric label="Jetons" value={selectedAgent.metrics.tokensUsed.toLocaleString()} />
              </dl>

              <button
                type="button"
                className="btn w-full !text-xs"
                onClick={() => navigate('/agents')}
              >
                Ouvrir la fiche du spécialiste
              </button>
            </div>
          )}

          {selectedBuilding && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-[--color-muted]">{selectedBuilding.purpose}</p>

              <div>
                <div className="mb-1 flex items-center justify-between text-[0.68rem] text-[--color-faint]">
                  <span>Développement · niveau {selectedBuilding.level}</span>
                  <span>{Math.round(selectedBuilding.activityScore)} d’activité</span>
                </div>
                <ProgressBar value={Math.min(1, selectedBuilding.level / 10)} tone="vital" />
              </div>

              <div>
                <div className="mb-1.5 text-[0.68rem] uppercase tracking-wider text-[--color-faint]">
                  Occupants ({residents.length})
                </div>
                <ul className="space-y-1">
                  {residents.map((resident) => (
                    <li key={resident.key} className="flex items-center justify-between text-xs">
                      <span className="text-[--color-ink]">{resident.name}</span>
                      <AgentStatusChip status={resident.state.status} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* ── Active missions ────────────────────────────────────────────── */}
      {village && village.activeMissions.length > 0 && !selected && (
        <aside className="absolute right-5 top-24 w-80 animate-rise rounded-xl border border-white/10 bg-black/55 p-4 backdrop-blur-md">
          <div className="mb-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-[--color-faint]">
            Missions en cours
          </div>
          <ul className="space-y-2.5">
            {village.activeMissions.slice(0, 4).map((mission) => (
              <li key={mission.id}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => navigate(`/missions/${mission.id}`)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-[--color-ink]">{mission.title}</span>
                    <MissionStatusChip status={mission.status} />
                  </div>
                  <div className="mt-1.5">
                    <ProgressBar value={mission.progress} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      {!village && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="rounded-xl border border-white/10 bg-black/60 px-6 py-4 text-sm text-[--color-muted] backdrop-blur">
            Connexion au village…
          </div>
        </div>
      )}
    </div>
  );
}

const VitalTile = ({ label, value, tone = 'text-[--color-ink]' }: { label: string; value: string | number; tone?: string }) => (
  <div className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-center backdrop-blur">
    <div className={`font-display text-lg font-semibold leading-none ${tone}`}>{value}</div>
    <div className="mt-1 text-[0.6rem] uppercase tracking-[0.12em] text-[--color-faint]">{label}</div>
  </div>
);

const Metric = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
    <dt className="text-[0.6rem] uppercase tracking-wider text-[--color-faint]">{label}</dt>
    <dd className="mt-0.5 font-display text-sm text-[--color-ink]">{value}</dd>
  </div>
);

const ControlButton = ({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="grid size-9 place-items-center rounded-lg border border-white/10 bg-black/55 text-[--color-muted] backdrop-blur transition-colors hover:border-sky-500/40 hover:text-[--color-ink]"
  >
    {children}
  </button>
);
