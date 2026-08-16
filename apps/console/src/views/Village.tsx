import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Agent, Building } from '@atlas/contracts';
import { useAtlas } from '../store.ts';
import { VillageRenderer, type HitTarget } from '../village/renderer.ts';
import { OCCUPATION_LABEL, type CityPulse, type Occupation } from '../village/life.ts';
import { DISTRICTS, districtOf, styleOf } from '../village/layout.ts';
import { AgentStatusChip, MissionStatusChip, ProgressBar, relativeTime } from '../components/ui.tsx';

/**
 * La cité ATLAS — le mode immersif (SRS §3).
 *
 * Le canevas porte le monde ; tout ce qui se superpose répond à « que se
 * passe-t-il en ce moment » sans quitter la vue. Sélectionner un habitant ou un
 * bâtiment ouvre sa fiche réelle : la ville est une porte d'entrée dans le
 * système, pas une image de celui-ci.
 *
 * Deux registres cohabitent et l'interface les nomme. Le travail réel vient du
 * serveur ; la vie du village est une animation locale qui n'écrit nulle part.
 * Confondre les deux ferait passer une réunion inventée pour une découverte, et
 * c'est exactement ce que cette distinction empêche.
 */
export function VillageView() {
  const navigate = useNavigate();
  const { village, connect, connection, mode } = useAtlas();
  const feed = useAtlas((s) => s.feed);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VillageRenderer | null>(null);
  const [selected, setSelected] = useState<HitTarget | null>(null);
  const [pulse, setPulse] = useState<CityPulse | null>(null);
  const [occupations, setOccupations] = useState<Map<string, Occupation>>(new Map());
  const [panel, setPanel] = useState<'life' | 'districts'>('life');

  useEffect(() => {
    connect(['event', 'village', 'stats']);
  }, [connect]);

  const onTick = useCallback((nextPulse: CityPulse, nextOccupations: Map<string, Occupation>) => {
    setPulse(nextPulse);
    // Copie : la carte du moteur est mutée sur place à chaque image, la
    // transmettre telle quelle empêcherait React de voir le changement.
    setOccupations(new Map(nextOccupations));
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new VillageRenderer(canvasRef.current);
    rendererRef.current = renderer;
    renderer.onSelect = setSelected;
    renderer.onTick = onTick;
    renderer.start();

    const onResize = (): void => renderer.resize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [onTick]);

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

  /** Qui se trouve dans ce bâtiment à l'instant présent, réel ou ambiant. */
  const residents = useMemo(() => {
    if (!selectedBuilding || !village) return [];
    return village.agents.filter((agent) => {
      const occupation = occupations.get(agent.key);
      const where = occupation?.at ?? agent.state.location ?? agent.building;
      return where === selectedBuilding.key && occupation?.phase !== 'travelling';
    });
  }, [selectedBuilding, village, occupations]);

  const stats = village?.stats;
  const activity = feed.filter((e) => e.severity !== 'debug').slice(0, 6);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[--color-void]">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" aria-label="Carte de la cité ATLAS" />

      {/* ── Bandeau supérieur ──────────────────────────────────────────── */}
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
            <VitalTile label="Au travail" value={pulse?.realWorkers ?? 0} tone="text-sky-300" />
            <VitalTile label="Missions du jour" value={stats.missionsToday} tone="text-emerald-300" />
            <VitalTile label="Connaissances" value={stats.knowledgeItems} tone="text-violet-300" />
            <VitalTile
              label="Vitalité"
              value={`${stats.vitality} %`}
              tone={
                stats.vitality > 70
                  ? 'text-emerald-300'
                  : stats.vitality > 40
                    ? 'text-amber-300'
                    : 'text-rose-300'
              }
            />
          </div>
        )}
      </div>

      {/* ── Le pouls de la cité ────────────────────────────────────────── */}
      {pulse && (
        <div className="pointer-events-none absolute left-5 top-24 w-[19rem]">
          <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/60 p-3.5 backdrop-blur">
            <div className="flex items-center gap-2.5">
              <span
                className={`size-2.5 rounded-full ${MOOD_DOT[pulse.mood]} ${
                  pulse.mood !== 'calm' ? 'animate-pulse-soft' : ''
                }`}
              />
              <span className="font-display text-sm font-semibold text-[--color-ink]">{pulse.label}</span>
              <span className="ml-auto text-[0.6rem] uppercase tracking-[0.14em] text-[--color-faint]">
                Rythme de la cité
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-[--color-muted]">{pulse.detail}</p>

            <div className="mt-3 space-y-1.5">
              <LifeBar
                label="Travail réel"
                value={pulse.realWorkers}
                total={stats?.population ?? 0}
                tone="bg-sky-400"
                hint="Étapes de mission pilotées par le serveur"
              />
              <LifeBar
                label="Vie du village"
                value={pulse.ambientWorkers}
                total={stats?.population ?? 0}
                tone="bg-slate-400"
                hint="Animation locale, sans effet métier"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Panneau de droite : habitants ou quartiers ─────────────────── */}
      {village && !selected && (
        <aside className="absolute right-5 top-24 w-[21rem] animate-rise overflow-hidden rounded-xl border border-white/10 bg-black/60 backdrop-blur-md">
          <div className="flex border-b border-white/10">
            {(
              [
                ['life', 'Habitants'],
                ['districts', 'Quartiers'],
              ] as Array<['life' | 'districts', string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPanel(key)}
                className={`flex-1 px-3 py-2 text-xs transition-colors ${
                  panel === key
                    ? 'bg-white/5 font-medium text-[--color-ink]'
                    : 'text-[--color-faint] hover:text-[--color-muted]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {panel === 'life' ? (
            <ul className="max-h-[24rem] divide-y divide-white/5 overflow-y-auto">
              {village.agents.map((agent) => {
                const occupation = occupations.get(agent.key);
                const real = occupation?.real === true;
                return (
                  <li key={agent.key}>
                    <button
                      type="button"
                      className="w-full px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                      onClick={() => rendererRef.current?.focusBuilding(occupation?.at ?? agent.building)}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${
                            agent.state.status === 'error'
                              ? 'bg-rose-400'
                              : real
                                ? 'bg-sky-400'
                                : 'bg-slate-500'
                          }`}
                        />
                        <span className="truncate text-xs font-medium text-[--color-ink]">{agent.name}</span>
                        <span
                          className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[0.56rem] uppercase tracking-wider ${
                            real ? 'bg-sky-500/15 text-sky-300' : 'bg-white/5 text-[--color-faint]'
                          }`}
                        >
                          {real ? 'mission' : 'village'}
                        </span>
                      </div>
                      <div className="mt-1 truncate pl-3.5 text-[0.68rem] text-[--color-muted]">
                        {occupation?.label ?? 'En attente'}
                      </div>
                      <div className="mt-0.5 truncate pl-3.5 text-[0.6rem] text-[--color-faint]">
                        {occupation?.phase === 'travelling'
                          ? `en route vers ${styleOf(occupation.at).short}`
                          : styleOf(occupation?.at ?? agent.building).short}
                        {occupation ? ` · ${OCCUPATION_LABEL[occupation.kind]}` : ''}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="max-h-[24rem] divide-y divide-white/5 overflow-y-auto">
              {DISTRICTS.map((district) => {
                const members = village.buildings.filter((b) => styleOf(b.key).district === district.key);
                const busy = members.filter((b) => b.status === 'busy').length;
                const alert = members.filter((b) => b.status === 'alert').length;

                return (
                  <li key={district.key} className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-sm" style={{ background: district.accent }} />
                      <span className="text-xs font-medium text-[--color-ink]">{district.label}</span>
                      <span className="ml-auto text-[0.6rem] text-[--color-faint]">
                        {members.length} bâtiments
                      </span>
                    </div>
                    <p className="mt-0.5 pl-4 text-[0.62rem] text-[--color-faint]">{district.role}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1 pl-4">
                      {members.map((building) => (
                        <button
                          key={building.key}
                          type="button"
                          onClick={() => rendererRef.current?.focusBuilding(building.key)}
                          className={`rounded px-1.5 py-0.5 text-[0.6rem] transition-colors ${
                            building.status === 'alert'
                              ? 'bg-rose-500/15 text-rose-300'
                              : building.status === 'busy'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-white/5 text-[--color-faint] hover:text-[--color-muted]'
                          }`}
                        >
                          {styleOf(building.key).short}
                        </button>
                      ))}
                    </div>
                    {(busy > 0 || alert > 0) && (
                      <div className="mt-1 pl-4 text-[0.6rem] text-[--color-faint]">
                        {busy > 0 && <span className="text-emerald-300">{busy} en activité</span>}
                        {busy > 0 && alert > 0 && ' · '}
                        {alert > 0 && <span className="text-rose-300">{alert} en alerte</span>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {village.activeMissions.length > 0 && (
            <div className="border-t border-white/10 p-3">
              <div className="mb-2 text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-[--color-faint]">
                Missions en cours
              </div>
              <ul className="space-y-2">
                {village.activeMissions.slice(0, 3).map((mission) => (
                  <li key={mission.id}>
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => navigate(`/missions/${mission.id}`)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-[--color-ink]">
                          {mission.title}
                        </span>
                        <MissionStatusChip status={mission.status} />
                      </div>
                      <div className="mt-1.5">
                        <ProgressBar value={mission.progress} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      {/* ── Fiche de sélection ─────────────────────────────────────────── */}
      {(selectedAgent || selectedBuilding) && (
        <aside className="absolute right-5 top-24 w-[21rem] animate-rise rounded-xl border border-white/10 bg-black/70 p-4 backdrop-blur-md">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate font-display text-base font-semibold">
                {selectedAgent?.name ?? selectedBuilding?.name}
              </h3>
              <p className="text-xs text-[--color-muted]">
                {selectedAgent?.role ?? selectedBuilding?.department}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 text-sm text-[--color-faint] hover:text-[--color-ink]"
              onClick={() => setSelected(null)}
              aria-label="Fermer le panneau"
            >
              ✕
            </button>
          </div>

          {selectedAgent && (
            <AgentCard
              agent={selectedAgent}
              occupation={occupations.get(selectedAgent.key) ?? null}
              onOpen={() => navigate('/agents')}
            />
          )}

          {selectedBuilding && (
            <BuildingCard building={selectedBuilding} residents={residents} occupations={occupations} />
          )}
        </aside>
      )}

      {/* ── Journal et légende ─────────────────────────────────────────── */}
      <div className="pointer-events-none absolute bottom-5 left-5 w-[24rem] max-w-[36vw] space-y-2">
        <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/60 p-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-[--color-faint]">
              Journal du système
            </span>
            <span className="flex items-center gap-1.5 text-[0.64rem] text-[--color-faint]">
              <span
                className={`size-1.5 rounded-full ${connection === 'live' ? 'bg-emerald-400' : 'bg-rose-400'}`}
              />
              {connection === 'live' ? 'connecté' : connection === 'connecting' ? 'connexion…' : 'hors ligne'}
            </span>
          </div>

          {activity.length === 0 ? (
            <p className="py-2 text-center text-xs text-[--color-faint]">
              Aucun événement métier. La cité continue de vivre — cette activité-là n’entre pas au journal.
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

        {/*
          La légende n'est pas décorative : sans elle, un observateur pourrait
          prendre une réunion ambiante pour une découverte réelle. Elle nomme la
          frontière que le reste du code applique.
        */}
        <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/55 px-3 py-2 text-[0.62rem] backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-sky-400" />
              <span className="text-[--color-muted]">Travail réel — piloté par le serveur</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-slate-500" />
              <span className="text-[--color-faint]">Vie du village — animation, aucun effet métier</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Commandes de caméra ────────────────────────────────────────── */}
      <div className="absolute bottom-5 right-5 flex flex-col gap-1.5">
        <ControlButton label="Zoom avant" onClick={() => rendererRef.current?.zoomBy(1.2)}>
          +
        </ControlButton>
        <ControlButton label="Zoom arrière" onClick={() => rendererRef.current?.zoomBy(0.83)}>
          −
        </ControlButton>
        <ControlButton label="Cadrer la cité" onClick={() => rendererRef.current?.fit()}>
          ⊡
        </ControlButton>
      </div>

      {!village && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="rounded-xl border border-white/10 bg-black/60 px-6 py-4 text-sm text-[--color-muted] backdrop-blur">
            Connexion à la cité…
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Fiches ─────────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  occupation,
  onOpen,
}: {
  agent: Agent;
  occupation: Occupation | null;
  onOpen: () => void;
}) {
  const real = occupation?.real === true;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <AgentStatusChip status={agent.state.status} />
        <span className="text-xs text-[--color-faint]">{relativeTime(agent.state.lastActiveAt)}</span>
      </div>

      <p className="text-xs leading-relaxed text-[--color-muted]">{agent.mission}</p>

      {occupation && (
        <div
          className={`rounded-lg border p-2.5 ${
            real ? 'border-sky-500/25 bg-sky-500/10' : 'border-white/10 bg-white/5'
          }`}
        >
          <div
            className={`text-[0.6rem] uppercase tracking-wider ${real ? 'text-sky-300' : 'text-[--color-faint]'}`}
          >
            {real ? 'Étape de mission' : 'Activité de village'}
          </div>
          <div className="mt-0.5 text-xs text-[--color-ink]">{occupation.label}</div>
          <div className="mt-1 text-[0.62rem] text-[--color-faint]">
            {occupation.phase === 'travelling' ? 'en route vers ' : 'à '}
            {styleOf(occupation.at).short}
            {!real && ' · sans effet sur les données métier'}
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <Metric label="Étapes réussies" value={agent.metrics.tasksSucceeded} />
        <Metric label="Réussite" value={`${agent.metrics.successRate} %`} />
        <Metric label="Qualité" value={`${agent.metrics.qualityScore}/100`} />
        <Metric label="Jetons" value={agent.metrics.tokensUsed.toLocaleString('fr-FR')} />
      </dl>

      <button type="button" className="btn w-full !text-xs" onClick={onOpen}>
        Ouvrir la fiche du spécialiste
      </button>
    </div>
  );
}

function BuildingCard({
  building,
  residents,
  occupations,
}: {
  building: Building;
  residents: Agent[];
  occupations: Map<string, Occupation>;
}) {
  const district = districtOf(building.key);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[0.58rem] uppercase tracking-wider"
          style={{ background: `${district.accent}22`, color: district.accent }}
        >
          {district.label}
        </span>
        <span
          className={`chip ${
            building.status === 'alert'
              ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300'
              : building.status === 'busy'
                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border border-white/10 text-[--color-faint]'
          }`}
        >
          {building.status === 'alert' ? 'alerte' : building.status === 'busy' ? 'en activité' : 'au repos'}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-[--color-muted]">{building.purpose}</p>

      <div>
        <div className="mb-1 flex items-center justify-between text-[0.64rem] text-[--color-faint]">
          <span>Développement · niveau {building.level}</span>
          <span>{Math.round(building.activityScore)} d’activité</span>
        </div>
        <ProgressBar value={Math.min(1, building.level / 10)} tone="vital" />
      </div>

      <div>
        <div className="mb-1.5 text-[0.64rem] uppercase tracking-wider text-[--color-faint]">
          Présents ({residents.length})
        </div>
        {residents.length === 0 ? (
          <p className="text-xs text-[--color-faint]">Personne sur place actuellement.</p>
        ) : (
          <ul className="space-y-1">
            {residents.map((resident) => {
              const occupation = occupations.get(resident.key);
              return (
                <li key={resident.key} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-[--color-ink]">{resident.name}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[0.56rem] uppercase tracking-wider ${
                      occupation?.real ? 'bg-sky-500/15 text-sky-300' : 'bg-white/5 text-[--color-faint]'
                    }`}
                  >
                    {occupation?.real ? 'mission' : 'village'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Petits éléments ────────────────────────────────────────────────────────

const MOOD_DOT: Record<CityPulse['mood'], string> = {
  calm: 'bg-slate-400',
  active: 'bg-sky-400',
  council: 'bg-violet-400',
  incident: 'bg-rose-400',
};

const LifeBar = ({
  label,
  value,
  total,
  tone,
  hint,
}: {
  label: string;
  value: number;
  total: number;
  tone: string;
  hint: string;
}) => (
  <div title={hint}>
    <div className="flex items-baseline justify-between text-[0.62rem]">
      <span className="text-[--color-muted]">{label}</span>
      <span className="text-[--color-faint]">
        {value}/{total || '—'}
      </span>
    </div>
    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/5">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
        style={{ width: `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%` }}
      />
    </div>
  </div>
);

const VitalTile = ({
  label,
  value,
  tone = 'text-[--color-ink]',
}: {
  label: string;
  value: string | number;
  tone?: string;
}) => (
  <div className="rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-center backdrop-blur">
    <div className={`font-display text-lg font-semibold leading-none ${tone}`}>{value}</div>
    <div className="mt-1 text-[0.56rem] uppercase tracking-[0.12em] text-[--color-faint]">{label}</div>
  </div>
);

const Metric = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
    <dt className="text-[0.56rem] uppercase tracking-wider text-[--color-faint]">{label}</dt>
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
