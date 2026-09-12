import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Department, DepartmentStats } from '@atlas/contracts';
import { api, ApiError } from '../lib/api.ts';
import { Panel, StatCard, Empty, Spinner, ErrorNote, MissionStatusChip, formatNumber } from '../components/ui.tsx';

/**
 * Departments — the products (Article XIV).
 *
 * A department is only real if you can see its method, the teams that run it,
 * and whether it can actually be run right now. So this screen leads with
 * readiness rather than with marketing: a stage whose agent lacks a required
 * skill is shown as broken, because that is what it is.
 */
export function DepartmentsView() {
  const [rows, setRows] = useState<Array<{ department: Department; stats: DepartmentStats }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    api
      .departments()
      .then((data) => {
        setRows(data);
        setSelected((current) => current ?? data[0]?.department.key ?? null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Impossible de charger les départements.'));
  };

  useEffect(load, []);

  if (error) return <ErrorNote message={error} onRetry={load} />;
  if (!rows) return <Spinner label="Chargement des départements" />;
  if (rows.length === 0) {
    return <Empty icon="◫" title="Aucun département pour l’instant" hint="ATLAS OS est la plateforme ; les départements sont les produits." />;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-semibold">Départements</h1>
        <p className="mt-1 text-sm text-[--color-muted]">
          Chaque département est un produit qu’ATLAS peut vendre seul : ses cibles, sa méthode, son score et ses équipes.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map(({ department, stats }) => (
          <button
            key={department.key}
            type="button"
            onClick={() => setSelected(department.key)}
            className={`panel p-5 text-left transition ${
              selected === department.key ? 'ring-1 ring-[--color-atlas]' : 'hover:border-[--color-atlas]/40'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold">{department.name}</h2>
                <p className="mt-0.5 text-xs text-[--color-muted]">{department.tagline}</p>
              </div>
              <span className={`chip ${department.enabled ? 'text-[--color-vital]' : 'text-[--color-faint]'}`}>
                {department.enabled ? 'en service' : 'hors service'}
              </span>
            </div>

            <dl className="mt-4 grid grid-cols-4 gap-2 text-center text-[0.6875rem]">
              <Metric label="Missions" value={formatNumber(stats.missionsTotal)} />
              <Metric label="Découvertes" value={formatNumber(stats.opportunitiesDiscovered)} />
              <Metric label="Qualifiées" value={formatNumber(stats.opportunitiesQualified)} />
              <Metric label="Retenues" value={formatNumber(stats.opportunitiesShortlisted)} />
            </dl>

            <p className="mt-3 text-[0.6875rem] text-[--color-faint]">
              {stats.costPerQualifiedOpportunity !== null
                ? `≈ $${stats.costPerQualifiedOpportunity.toFixed(4)} par opportunité qualifiée`
                : 'Cost par opportunité qualifiée: not yet measurable'}
            </p>
          </button>
        ))}
      </div>

      {selected && <DepartmentDetail key={selected} departmentKey={selected} />}
    </div>
  );
}

/** Renders `{{markets.countries}}` as the slot it is: ⟨countries⟩. */
const asTemplate = (text: string): string =>
  text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => `⟨${path.split('.').pop()}⟩`);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[--color-faint]">{label}</dt>
      <dd className="font-display text-sm text-[--color-ink]">{value}</dd>
    </div>
  );
}

function DepartmentDetail({ departmentKey }: { departmentKey: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.department>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .department(departmentKey)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Impossible de charger le département.'));
  }, [departmentKey]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Spinner label="Chargement du département" />;

  const { department, readiness, missions, stats } = data;
  const blocked = readiness.filter((stage) => !stage.ready);

  return (
    <div className="space-y-4">
      <Panel title={department.name} subtitle={department.mission}>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <section>
              <h3 className="label">Méthode</h3>
              {blocked.length > 0 && (
                <p className="mb-2 rounded border border-[--color-alert]/40 bg-[--color-alert]/10 px-3 py-2 text-xs text-[--color-alert]">
                  {blocked.length} étape(s) ne peuvent pas s’exécuter : l’agent affecté n’a pas une compétence requise ou est
                  désactivé. Le département échouera à la planification, pas au milieu d’une mission.
                </p>
              )}
              <ol className="space-y-2">
                {readiness.map((stage, index) => (
                  <li
                    key={stage.ref}
                    className="flex items-start gap-3 rounded border border-[--color-border] px-3 py-2"
                  >
                    <span className="mt-0.5 font-display text-xs text-[--color-faint]">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {/*
                          This is the method, not a run of it, so the title
                          still carries its brief slots. Showing them as slots
                          reads as a template; showing them as `{{…}}` reads as
                          a bug.
                        */}
                        <span className="text-sm text-[--color-ink]">{asTemplate(stage.title)}</span>
                        <span className="chip border border-[--color-border] text-[--color-faint]">
                          {stage.team}
                        </span>
                        <span className="chip border border-[--color-border] text-[--color-faint]">
                          {stage.agentName ?? stage.agentKey}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {stage.requiredSkills.map((skill) => (
                          <span key={skill} className="chip border border-[--color-atlas]/40 text-[--color-atlas]">
                            {skill}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span
                      className={`chip ${stage.ready ? 'text-[--color-vital]' : 'text-[--color-alert]'}`}
                      title={stage.ready ? 'Cette étape peut s’exécuter' : 'L’agent affecté ne peut pas exécuter cette étape'}
                    >
                      {stage.ready ? 'prête' : 'bloquée'}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3 className="label">Modèle de score</h3>
              <p className="mb-2 text-xs text-[--color-muted]">{department.scoringModel.narrative}</p>
              <div className="space-y-1">
                {department.scoringModel.dimensions.map((dimension) => (
                  <div key={dimension.key} className="flex items-center gap-3 text-xs">
                    <span className="w-40 shrink-0 text-[--color-ink]">{dimension.label}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded bg-[--color-border]">
                      <div
                        className="h-full rounded bg-[--color-atlas]"
                        style={{ width: `${(dimension.weight / 40) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-[--color-faint]">{dimension.weight}</span>
                    {dimension.computed && (
                      <span className="chip text-[--color-vital]" title="Calculé par ATLAS depuis le registre de preuves">
                        computed
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[0.6875rem] text-[--color-faint]">
                Seuil de shortlist : {department.scoringModel.shortlistThreshold}/100.
              </p>
            </section>
          </div>

          <div className="space-y-4">
            <section>
              <h3 className="label">Équipes</h3>
              <div className="space-y-2">
                {department.teams.map((team) => (
                  <div key={team.key} className="rounded border border-[--color-border] px-3 py-2">
                    <p className="text-sm text-[--color-ink]">{team.name}</p>
                    <p className="mt-0.5 text-[0.6875rem] text-[--color-muted]">{team.purpose}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {team.agentKeys.map((key) => (
                        <span key={key} className="chip border border-[--color-border] text-[--color-faint]">
                          {key}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="label">Cibles recherchées</h3>
              <div className="flex flex-wrap gap-1">
                {department.targetTypes.map((target) => (
                  <span
                    key={target.key}
                    title={target.description}
                    className="chip border border-[--color-border] text-[--color-muted]"
                  >
                    {target.label}
                  </span>
                ))}
              </div>
            </section>

            <section>
              <h3 className="label">Économie unitaire</h3>
              <StatCard
                label="Cost par opportunité qualifiée"
                value={
                  stats.costPerQualifiedOpportunity !== null
                    ? `$${stats.costPerQualifiedOpportunity.toFixed(4)}`
                    : '—'
                }
                hint={`${formatNumber(stats.evidenceItems)} preuves · ${formatNumber(stats.companiesKnown)} entreprises connues`}
              />
            </section>
          </div>
        </div>
      </Panel>

      <Panel title="Missions" subtitle="Le travail confié à ce département">
        {missions.length === 0 ? (
          <Empty icon="▶" title="Aucune mission pour l’instant" hint="Créez-en une depuis l’écran Missions." />
        ) : (
          <ul className="divide-y divide-[--color-border]">
            {missions.map((mission) => (
              <li key={mission.id} className="flex items-center justify-between gap-3 py-2">
                <Link to={`/missions/${mission.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="text-sm text-[--color-ink]">{mission.title}</span>
                  <span className="ml-2 text-[0.6875rem] text-[--color-faint]">{mission.code}</span>
                </Link>
                <MissionStatusChip status={mission.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
