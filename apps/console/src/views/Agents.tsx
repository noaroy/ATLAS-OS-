import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import {
  AgentStatusChip,
  Empty,
  ErrorNote,
  Panel,
  ProgressBar,
  Spinner,
  formatDuration,
  formatNumber,
  relativeTime,
} from '../components/ui.tsx';

/** Agent supervision (SRS §4.14): who is on the team and how well they work. */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.agent>> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      setAgents(await api.agents());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agents');
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void api.agent(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  const toggle = async (agent: Agent): Promise<void> => {
    setSaving(true);
    try {
      await api.updateAgent(agent.key, { enabled: !agent.enabled });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const byTier = (tier: Agent['tier']): Agent[] => (agents ?? []).filter((a) => a.tier === tier);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-sm text-[--color-muted]">
          The specialists of ATLAS. Each holds one responsibility and only the tools it needs.
        </p>
      </header>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}
      {agents === null && <Spinner />}

      {agents && agents.length === 0 && <Empty icon="◇" title="Aucun spécialiste enregistré" />}

      {(['business', 'support', 'evolution', 'director'] as const).map((tier) => {
        const group = byTier(tier);
        if (group.length === 0) return null;
        return (
          <section key={tier} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[--color-faint]">
              {tier === 'business'
                ? 'Business specialists'
                : tier === 'support'
                  ? 'Support'
                  : tier === 'evolution'
                    ? 'Evolution'
                    : 'Direction'}
            </h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.map((agent) => (
                <article
                  key={agent.key}
                  className={`panel p-4 transition-opacity ${agent.enabled ? '' : 'opacity-55'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="grid size-10 shrink-0 place-items-center rounded-xl text-base font-semibold"
                        style={{
                          background: `hsl(${agent.appearance.hue} 60% 22%)`,
                          color: agent.appearance.accent,
                          border: `1px solid ${agent.appearance.accent}44`,
                        }}
                        aria-hidden
                      >
                        {agent.appearance.emblem}
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-[--color-ink]">{agent.name}</h3>
                        <p className="truncate text-xs text-[--color-muted]">{agent.role}</p>
                      </div>
                    </div>
                    <AgentStatusChip status={agent.state.status} />
                  </div>

                  <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-[--color-muted]">
                    {agent.mission}
                  </p>

                  {agent.state.currentActivity && (
                    <div className="mt-3 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-200">
                      {agent.state.currentActivity}
                    </div>
                  )}

                  <div className="mt-3 space-y-2">
                    <div>
                      <div className="mb-1 flex items-center justify-between text-[0.68rem] text-[--color-faint]">
                        <span>Taux de réussite</span>
                        <span>{agent.metrics.successRate}%</span>
                      </div>
                      <ProgressBar
                        value={agent.metrics.successRate / 100}
                        tone={agent.metrics.successRate >= 80 ? 'vital' : agent.metrics.successRate >= 50 ? 'atlas' : 'alert'}
                      />
                    </div>

                    <dl className="grid grid-cols-3 gap-2 text-center text-[0.68rem]">
                      <div>
                        <dt className="text-[--color-faint]">Étapes</dt>
                        <dd className="font-display text-sm text-[--color-ink]">{agent.metrics.tasksTotal}</dd>
                      </div>
                      <div>
                        <dt className="text-[--color-faint]">Avg time</dt>
                        <dd className="font-display text-sm text-[--color-ink]">
                          {formatDuration(agent.metrics.avgDurationMs)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[--color-faint]">Qualité</dt>
                        <dd className="font-display text-sm text-[--color-ink]">
                          {agent.metrics.qualityScore}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  {/*
                    Skills are what the agent is composed of; tools are merely
                    what those skills unlock. Showing the skills first keeps the
                    console honest about where a permission actually comes from.
                  */}
                  <div className="mt-3 flex flex-wrap gap-1">
                    {agent.skills.map((skill) => (
                      <span key={skill} className="chip border border-[--color-atlas]/40 text-[--color-atlas]">
                        {skill}
                      </span>
                    ))}
                    {agent.tools.map((tool) => (
                      <span key={tool} className="chip border border-[--color-border] text-[--color-faint]">
                        {tool}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-[--color-border] pt-3">
                    <button
                      type="button"
                      className="text-xs text-[--color-atlas] hover:underline"
                      onClick={() => setSelected(selected === agent.key ? null : agent.key)}
                    >
                      {selected === agent.key ? 'Hide details' : 'Details'}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-[--color-faint] hover:text-[--color-ink]"
                      disabled={saving}
                      onClick={() => void toggle(agent)}
                    >
                      {agent.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>

                  {selected === agent.key && detail && (
                    <div className="mt-3 space-y-3 border-t border-[--color-border] pt-3 animate-rise">
                      <div>
                        <div className="label">Skills</div>
                        <div className="flex flex-wrap gap-1">
                          {agent.skills.map((skill) => (
                            <span key={skill} className="chip border border-[--color-border-bright] text-[--color-muted]">
                              {skill}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="label">Activité récente</div>
                        {detail.recentEvents.length === 0 ? (
                          <p className="text-xs text-[--color-faint]">Nothing recorded yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {detail.recentEvents.slice(0, 6).map((event) => (
                              <li key={event.id} className="text-xs text-[--color-muted]">
                                <span className="text-[--color-faint]">{relativeTime(event.createdAt)}</span>{' '}
                                {event.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="text-[0.68rem] text-[--color-faint]">
                        Home: {agent.building} · Tokens used: {formatNumber(agent.metrics.tokensUsed)} ·{' '}
                        Étapes max : {agent.maxSteps}
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        );
      })}

      <Panel title="Comment ajouter un spécialiste">
        <p className="text-sm leading-relaxed text-[--color-muted]">
          New agents can be enregistrée le at runtime through{' '}
          <code className="rounded bg-[--color-deep] px-1.5 py-0.5 text-xs">POST /api/agents</code> — give it a
          key, a building, its own responsibility, the actions it advertises, and an allow-list of tools. It
          appears in the village and becomes available to Plan d’Hermèsner immediately, with no redeploy.
        </p>
      </Panel>
    </div>
  );
}
