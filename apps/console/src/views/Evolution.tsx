import { useCallback, useEffect, useState } from 'react';
import type { Improvement } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { Empty, ErrorNote, Panel, Spinner, StatCard, relativeTime } from '../components/ui.tsx';

const RISK_TONE: Record<string, string> = {
  low: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  medium: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  high: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
};

const STATUS_TONE: Record<string, string> = {
  proposed: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
  approved: 'border-indigo-500/25 bg-indigo-500/10 text-indigo-300',
  applied: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  rejected: 'border-[--color-border] text-[--color-faint]',
  reverted: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
  failed: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
};

/**
 * Self-improvement, under control (SRS §3.12, §6.8).
 *
 * Every proposal states its evidence and its exact change, and every applied
 * change can be reverted — which is what makes leaving the loop running safe.
 */
export function EvolutionView() {
  const [items, setItems] = useState<Improvement[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const result = await api.improvements(filter || undefined);
      setItems(result.items);
      setCounts(result.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load improvements');
      setItems([]);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (improvement: Improvement, decision: 'approve' | 'reject' | 'revert'): Promise<void> => {
    setBusy(improvement.id);
    try {
      await api.decideImprovement(improvement.id, decision);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that decision');
    } finally {
      setBusy(null);
    }
  };

  const runCycle = async (): Promise<void> => {
    setBusy('cycle');
    try {
      const result = await api.runEvolution();
      setError(
        `Cycle complete — ${result.proposed} new proposal(s), ${result.autoApplied} auto-applied, ${result.skipped} already open.`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Évolution</h1>
          <p className="mt-1 text-sm text-[--color-muted]">
            Ce qu’ATLAS propose de changer en lui-même. Vous décidez de ce qui change réellement.
          </p>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy === 'cycle'} onClick={() => void runCycle()}>
          {busy === 'cycle' ? 'Analysing…' : 'Run analysis now'}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Awaiting decision" value={counts.proposed ?? 0} tone="atlas" />
        <StatCard label="Applied" value={counts.applied ?? 0} tone="vital" />
        <StatCard label="Rejected" value={counts.rejected ?? 0} />
        <StatCard label="Reverted" value={counts.reverted ?? 0} tone="ember" />
      </div>

      <div className="rounded-lg border border-[--color-border] bg-[--color-surface] px-4 py-3 text-sm text-[--color-muted]">
        ATLAS can only propose changes from a fixed, declarative set — agent settings, orchestration limits,
        workflow toggles and memory retention. It cannot modify its own code, and every applied change stores
        the previous value so it can be reverted exactly.
      </div>

      <div className="flex gap-2">
        <select className="input max-w-48" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Toutes les propositions</option>
          <option value="proposed">Awaiting decision</option>
          <option value="applied">Applied</option>
          <option value="rejected">Rejected</option>
          <option value="reverted">Reverted</option>
        </select>
      </div>

      {error && <ErrorNote message={error} />}

      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Panel>
          <Empty
            icon="◉"
            title="Rien à proposer"
            hint="Le responsable de l’évolution ne propose un changement que lorsque les données l’étayent. Lancez d’autres missions et revenez."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {items.map((improvement) => (
            <article key={improvement.id} className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`chip border ${STATUS_TONE[improvement.status] ?? ''}`}>
                      {improvement.status}
                    </span>
                    <span className="chip border border-[--color-border] text-[--color-faint]">
                      {improvement.category}
                    </span>
                    <span className={`chip border ${RISK_TONE[improvement.risk] ?? ''}`}>
                      {improvement.risk} risk
                    </span>
                    <span className="chip border border-[--color-border] text-[--color-faint]">
                      {improvement.impact} impact
                    </span>
                  </div>

                  <h3 className="mt-2 text-sm font-semibold text-[--color-ink]">{improvement.title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-[--color-muted]">{improvement.rationale}</p>

                  <details className="mt-2.5">
                    <summary className="cursor-pointer text-xs text-[--color-atlas] hover:underline">
                      Changement exact et éléments à l’appui
                    </summary>
                    <div className="mt-2 space-y-2">
                      <div>
                        <div className="label">Change</div>
                        <pre className="overflow-x-auto rounded-lg bg-[--color-deep] p-2.5 font-mono text-[0.7rem] text-[--color-muted]">
                          {JSON.stringify(improvement.change, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="label">Evidence</div>
                        <pre className="overflow-x-auto rounded-lg bg-[--color-deep] p-2.5 font-mono text-[0.7rem] text-[--color-muted]">
                          {JSON.stringify(improvement.evidence, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </details>

                  {/*
                    Une proposition sans observation à l'appui n'est pas une
                    proposition, c'est une préférence. Le commentaire du contrat
                    dit « always traceable » ; rien ne le vérifiait à l'affichage,
                    et c'est précisément la proposition sans données qu'on approuve
                    le plus vite, parce qu'il n'y a rien à lire avant de cliquer.
                  */}
                  {Object.keys(improvement.evidence).length === 0 && (
                    <p className="mt-2 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[0.6875rem] leading-relaxed text-amber-300">
                      Aucune observation à l’appui. Rien n’étaye ce changement : à refuser, sauf
                      raison connue par ailleurs.
                    </p>
                  )}

                  {/*
                    Un changement appliqué sans instantané de l'état antérieur ne
                    peut pas être annulé. Le bouton « Revert » existe quand même —
                    le dire avant vaut mieux que de le découvrir en cliquant.
                  */}
                  {improvement.status === 'applied' && improvement.revertData === null && (
                    <p className="mt-2 rounded border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[0.6875rem] leading-relaxed text-rose-300">
                      Appliqué sans instantané de l’état antérieur — cette modification n’est pas
                      réversible automatiquement.
                    </p>
                  )}

                  <div className="mt-2 text-[0.6875rem] text-[--color-faint]">
                    Proposed by {improvement.proposedBy} · {relativeTime(improvement.createdAt)}
                    {improvement.appliedAt && ` · applied ${relativeTime(improvement.appliedAt)}`}
                    {improvement.decidedBy && ` · décidé par ${improvement.decidedBy}`}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col gap-2">
                  {improvement.status === 'proposed' && (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary !py-1 !text-xs"
                        disabled={busy === improvement.id}
                        onClick={() => void decide(improvement, 'approve')}
                      >
                        Approve &amp; apply
                      </button>
                      <button
                        type="button"
                        className="btn !py-1 !text-xs"
                        disabled={busy === improvement.id}
                        onClick={() => void decide(improvement, 'reject')}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {improvement.status === 'applied' && (
                    <button
                      type="button"
                      className="btn !py-1 !text-xs"
                      disabled={busy === improvement.id}
                      onClick={() => void decide(improvement, 'revert')}
                    >
                      Revert
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
