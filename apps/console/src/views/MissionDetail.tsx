import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type MissionDetail } from '../lib/api.ts';
import {
  Empty,
  ErrorNote,
  MissionStatusChip,
  Panel,
  ProgressBar,
  SeverityChip,
  Spinner,
  TaskStatusChip,
  formatDuration,
  formatNumber,
  formatUsd,
  relativeTime,
} from '../components/ui.tsx';
import { MissionOpportunities } from './Opportunities.tsx';
import { Cockpit, LiveBanner } from '../components/Cockpit.tsx';

type Tab = 'cockpit' | 'plan' | 'steps' | 'opportunities' | 'result' | 'trail';

/**
 * The full record of one mission (SRS §2.14).
 *
 * Everything needed to answer "why did this happen": Hermes' reasoning, each
 * step and who ran it, the deliverables, and the complete communication trail.
 */
export function MissionDetailView() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<MissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('cockpit');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      setError(null);
      setDetail(await api.mission(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de charger cette mission");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the mission is live — a finished record does not change.
  useEffect(() => {
    if (!detail) return;
    const live = ['running', 'planned', 'assigned', 'created'].includes(detail.mission.status);
    if (!live) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [detail, load]);

  const act = async (action: string): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.missionAction(id, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Action « ${action} » impossible sur cette mission`);
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <ErrorNote message={error} onRetry={() => void load()} />;
  if (!detail) return <Spinner label="Chargement de la mission…" />;

  const { mission, tasks, messages, events, economics } = detail;
  const canStart = ['created', 'planned', 'paused'].includes(mission.status);
  const canPause = mission.status === 'running';
  const canRetry = mission.status === 'failed';
  const canValidate = mission.status === 'completed';

  return (
    <div className="space-y-5">
      <div>
        <Link to="/missions" className="text-xs text-[--color-muted] hover:text-[--color-ink]">
          ← Toutes les missions
        </Link>
      </div>

      <LiveBanner cockpit={detail.cockpit} />

      <header className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-[--color-faint]">{mission.code}</span>
              <MissionStatusChip status={mission.status} />
              {detail.isActive && (
                <span className="chip border border-sky-500/30 bg-sky-500/10 text-sky-300">
                  <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
                  en exécution
                </span>
              )}
            </div>
            <h1 className="mt-2 font-display text-xl font-semibold tracking-tight">{mission.title}</h1>
            <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-[--color-muted]">
              {mission.objective}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {canStart && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('start')}>
                {mission.status === 'paused' ? 'Reprendre' : 'Démarrer'}
              </button>
            )}
            {canPause && (
              <button type="button" className="btn" disabled={busy} onClick={() => void act('pause')}>
                Mettre en pause
              </button>
            )}
            {canRetry && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('retry')}>
                Relancer
              </button>
            )}
            {canValidate && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('validate')}>
                Valider
              </button>
            )}
            {!['archived', 'validated'].includes(mission.status) && (
              <button type="button" className="btn" disabled={busy} onClick={() => void act('cancel')}>
                Annuler
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Meta label="Avancement" value={`${Math.round(mission.progress * 100)} %`}>
            <div className="mt-1.5">
              <ProgressBar
                value={mission.progress}
                tone={mission.status === 'failed' ? 'alert' : mission.status === 'completed' ? 'vital' : 'atlas'}
              />
            </div>
          </Meta>
          <Meta label="Créée" value={relativeTime(mission.createdAt)} />
          <Meta
            label="Durée"
            value={
              mission.startedAt
                ? formatDuration(
                    (mission.finishedAt ? Date.parse(mission.finishedAt) : Date.now()) -
                      Date.parse(mission.startedAt),
                  )
                : '—'
            }
          />
          {/*
            Les jetons viennent du compteur de la mission, pas de son résultat :
            celui-ci n'existe qu'une fois la mission terminée, si bien qu'une
            mission en cours affichait 0 jeton pendant tout son déroulement.
          */}
          <Meta label="Jetons" value={formatNumber(economics.tokensUsed)} />
          {/*
            Le coût, et ce qui l'a produit. Un « 0,00 $ » ne dit pas la même
            chose selon qu'on tourne sur des jetons simulés ou sur de
            l'inférence facturée : le mode est écrit sous le chiffre, jamais
            déduit par le lecteur.
          */}
          <Meta label="Coût réel" value={formatUsd(economics.estimatedCostUsd)}>
            <div className="mt-1 text-[0.6875rem] uppercase tracking-[0.12em]">
              {detail.mode === 'simulation' ? (
                <span className="text-amber-300">Simulation · aucune dépense</span>
              ) : economics.measured ? (
                <span className="text-[--color-faint]">
                  Mesuré sur {formatNumber(economics.measured.llmCalls)} appel(s)
                </span>
              ) : (
                <span className="text-[--color-faint]">Estimé</span>
              )}
            </div>
          </Meta>
        </div>

        {mission.error && (
          <div className="mt-4 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {mission.error}
          </div>
        )}
      </header>

      <nav className="flex gap-1 border-b border-[--color-border]">
        {(
          [
            ['cockpit', 'Cockpit'],
            ['steps', `Étapes (${tasks.length})`],
            ['plan', "Plan d’Hermès"],
            // Only a department mission has a pipeline to show.
            ...(mission.departmentKey ? ([['opportunities', 'Opportunités']] as Array<[Tab, string]>) : []),
            ['result', 'Résultat'],
            ['trail', `Journal (${messages.length + events.length})`],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition-colors ${
              tab === key
                ? 'border-[--color-atlas] font-medium text-[--color-ink]'
                : 'border-transparent text-[--color-muted] hover:text-[--color-ink]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'cockpit' && (
        <Cockpit
          missionId={mission.id}
          cockpit={detail.cockpit}
          decisions={detail.decisions}
          unsupportedClaims={detail.unsupportedClaims}
        />
      )}

      {tab === 'steps' && (
        <div className="space-y-3">
          {tasks.length === 0 ? (
            <Empty icon="◇" title="Pas encore planifiée" hint="Hermès analyse l’objectif." />
          ) : (
            tasks.map((task) => (
              <article key={task.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[0.7rem] text-[--color-faint]">{task.ref}</span>
                      <TaskStatusChip status={task.status} />
                      <span className="chip border border-[--color-border-bright] text-[--color-muted]">
                        {task.agentKey}
                      </span>
                      <span className="text-[0.7rem] text-[--color-faint]">{task.action}</span>
                      {task.dependsOn.length > 0 && (
                        <span className="text-[0.7rem] text-[--color-faint]">
                          after {task.dependsOn.join(', ')}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-1.5 text-sm font-medium text-[--color-ink]">{task.title}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[--color-muted]">
                      {task.instruction}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-[--color-faint]">
                    <div>{formatDuration(task.durationMs)}</div>
                    <div>{formatNumber(task.tokensUsed)} tok</div>
                    {task.attempts > 1 && <div>attempt {task.attempts}</div>}
                  </div>
                </div>

                {task.error && (
                  <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    {task.error}
                  </div>
                )}

                {task.output?.summary != null && (
                  <details className="mt-3 group">
                    <summary className="cursor-pointer text-xs font-medium text-[--color-atlas] hover:underline">
                      Result from {task.agentKey}
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-[--color-deep] p-3 font-sans text-xs leading-relaxed text-[--color-muted]">
                      {String(task.output.summary)}
                    </pre>
                  </details>
                )}
              </article>
            ))
          )}
        </div>
      )}

      {tab === 'opportunities' && mission.departmentKey && (
        <MissionOpportunities missionId={mission.id} />
      )}

      {tab === 'plan' && (
        <Panel title="Comment Hermès a décomposé cet objectif">
          {!mission.plan ? (
            <Empty icon="◈" title="Pas encore de plan" />
          ) : (
            <div className="space-y-4 text-sm">
              <Field label="Strategy" value={mission.plan.strategy} />
              <Field label="Rationale" value={mission.plan.rationale} />
              <Field label="Summary" value={mission.plan.summary} />
              <div className="text-xs text-[--color-faint]">
                Produced by {mission.plan.producedBy} · {relativeTime(mission.plan.producedAt)}
              </div>
            </div>
          )}
        </Panel>
      )}

      {tab === 'result' && (
        <div className="space-y-4">
          {!mission.result ? (
            <Empty icon="◆" title="Pas encore de résultat" hint="Le rapport apparaît une fois la mission terminée." />
          ) : (
            <>
              <Panel title={`Report · quality ${mission.result.quality}/100`}>
                <div className="prose-atlas whitespace-pre-wrap text-sm leading-relaxed text-[--color-muted]">
                  {mission.result.summary}
                </div>
              </Panel>

              {mission.result.artifacts.length > 0 && (
                <Panel title="Deliverables" dense>
                  <ul className="divide-y divide-[--color-border]">
                    {mission.result.artifacts.map((artifact) => (
                      <li key={artifact.path} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-[--color-ink]">{artifact.name}</div>
                          <div className="text-xs text-[--color-faint]">
                            {artifact.kind} · {(artifact.bytes / 1024).toFixed(1)} KB · by {artifact.createdBy}
                          </div>
                        </div>
                        <a
                          className="btn !py-1 !text-xs"
                          href={`/api/artifacts/${artifact.path}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open
                        </a>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'trail' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Communication" dense>
            {messages.length === 0 ? (
              <Empty icon="✉" title="Aucun message" />
            ) : (
              <ul className="max-h-[32rem] divide-y divide-[--color-border] overflow-y-auto">
                {messages.map((message) => (
                  <li key={message.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-[--color-ink]">{message.from}</span>
                      <span className="text-[--color-faint]">→</span>
                      <span className="font-medium text-[--color-ink]">{message.to}</span>
                      <span className="chip border border-[--color-border] text-[--color-faint]">
                        {message.kind}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-[--color-muted]">{message.objective}</div>
                    <div className="mt-0.5 text-[0.6875rem] text-[--color-faint]">
                      {relativeTime(message.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Events" dense>
            {events.length === 0 ? (
              <Empty icon="≡" title="Aucun événement" />
            ) : (
              <ul className="max-h-[32rem] divide-y divide-[--color-border] overflow-y-auto">
                {events.map((event) => (
                  <li key={event.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[0.6875rem] text-[--color-faint]">{event.type}</span>
                      <SeverityChip severity={event.severity} />
                    </div>
                    <div className="mt-1 text-xs text-[--color-muted]">{event.message}</div>
                    <div className="mt-0.5 text-[0.6875rem] text-[--color-faint]">
                      {relativeTime(event.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

const Meta = ({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) => (
  <div>
    <div className="label mb-0.5">{label}</div>
    <div className="text-sm font-medium text-[--color-ink]">{value}</div>
    {children}
  </div>
);

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="label">{label}</div>
    <p className="whitespace-pre-wrap leading-relaxed text-[--color-muted]">{value}</p>
  </div>
);
