import { useCallback, useEffect, useState } from 'react';
import type { Workflow, WorkflowRun } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { Empty, ErrorNote, Panel, Spinner, relativeTime } from '../components/ui.tsx';

const describeTrigger = (workflow: Workflow): string => {
  switch (workflow.trigger.type) {
    case 'schedule':
      return `Schedule · ${workflow.trigger.cron} (${workflow.trigger.timezone})`;
    case 'event':
      return `On event · ${workflow.trigger.event}`;
    case 'webhook':
      return 'Webhook';
    default:
      return 'Manual';
  }
};

/** The automation layer (SRS §2.12): Hermes decides, this executes. */
export function AutomationView() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [n8nEnabled, setN8nEnabled] = useState(false);
  const [runs, setRuns] = useState<Record<string, WorkflowRun[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      const result = await api.workflows();
      setWorkflows(result.workflows);
      setN8nEnabled(result.n8nEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load workflows');
      setWorkflows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const expand = async (workflow: Workflow): Promise<void> => {
    if (expanded === workflow.id) {
      setExpanded(null);
      return;
    }
    setExpanded(workflow.id);
    if (!runs[workflow.id]) {
      const history = await api.workflowRuns(workflow.id);
      setRuns((current) => ({ ...current, [workflow.id]: history }));
    }
  };

  const trigger = async (workflow: Workflow): Promise<void> => {
    setBusy(workflow.key);
    try {
      const result = await api.triggerWorkflow(workflow.key);
      setError(
        result.status === 'success'
          ? `"${workflow.name}" ran successfully.`
          : `"${workflow.name}" failed: ${result.error ?? 'unknown error'}`,
      );
      setRuns((current) => ({ ...current, [workflow.id]: [] }));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (workflow: Workflow): Promise<void> => {
    setBusy(workflow.key);
    try {
      await api.toggleWorkflow(workflow.key);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const internal = (workflows ?? []).filter((w) => w.key.startsWith('atlas.'));
  const external = (workflows ?? []).filter((w) => !w.key.startsWith('atlas.'));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Automatisation</h1>
        <p className="mt-1 text-sm text-[--color-muted]">
          Everything that runs on its own. Hermes decides what should happen; this layer carries it out.
        </p>
      </header>

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          n8nEnabled
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
            : 'border-[--color-border] bg-[--color-surface] text-[--color-muted]'
        }`}
      >
        {n8nEnabled ? (
          <>
            <strong className="font-semibold">n8n connected.</strong> External workflows are dispatched to n8n
            over its production webhooks.
          </>
        ) : (
          <>
            <strong className="font-semibold">n8n is not enabled.</strong> ATLAS's own scheduled jobs still run.
            To connect n8n, set <code>ATLAS_N8N_ENABLED=true</code> and its base URL, then register a workflow
            with a webhook path.
          </>
        )}
      </div>

      {error && <ErrorNote message={error} />}

      {workflows === null ? (
        <Spinner />
      ) : (
        <>
          <Section
            title="ATLAS maintenance jobs"
            subtitle="Tâches intégrées qui maintiennent l’organisation en bon état. Chacune se désactive sans toucher au code."
            workflows={internal}
            expanded={expanded}
            runs={runs}
            busy={busy}
            onExpand={expand}
            onTrigger={trigger}
            onToggle={toggle}
          />
          <Section
            title="External workflows"
            subtitle="Automatisations déléguées à n8n."
            workflows={external}
            expanded={expanded}
            runs={runs}
            busy={busy}
            onExpand={expand}
            onTrigger={trigger}
            onToggle={toggle}
            emptyHint="Register one with POST /api/workflows, giving it the webhook path n8n exposes."
          />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  workflows,
  expanded,
  runs,
  busy,
  onExpand,
  onTrigger,
  onToggle,
  emptyHint,
}: {
  title: string;
  subtitle: string;
  workflows: Workflow[];
  expanded: string | null;
  runs: Record<string, WorkflowRun[]>;
  busy: string | null;
  onExpand: (w: Workflow) => void;
  onTrigger: (w: Workflow) => void;
  onToggle: (w: Workflow) => void;
  emptyHint?: string;
}) {
  return (
    <Panel title={title} dense>
      <p className="border-b border-[--color-border] px-4 py-2 text-xs text-[--color-faint]">{subtitle}</p>
      {workflows.length === 0 ? (
        <Empty icon="⬢" title="None enregistrée le" hint={emptyHint} />
      ) : (
        <ul className="divide-y divide-[--color-border]">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[--color-ink]">{workflow.name}</span>
                    <span
                      className={`chip border ${
                        workflow.enabled
                          ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                          : 'border-[--color-border] text-[--color-faint]'
                      }`}
                    >
                      {workflow.enabled ? 'enabled' : 'disabled'}
                    </span>
                    {workflow.lastStatus && (
                      <span
                        className={`chip border ${
                          workflow.lastStatus === 'success'
                            ? 'border-emerald-500/25 text-emerald-300'
                            : 'border-rose-500/25 text-rose-300'
                        }`}
                      >
                        last {workflow.lastStatus}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[--color-muted]">{workflow.description}</p>
                  <div className="mt-1 text-[0.6875rem] text-[--color-faint]">
                    {describeTrigger(workflow)} · {workflow.runCount} run(s) ·{' '}
                    {workflow.lastRunAt ? `last ${relativeTime(workflow.lastRunAt)}` : 'never run'}
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="btn !py-1 !text-xs"
                    disabled={busy === workflow.key || !workflow.enabled}
                    onClick={() => onTrigger(workflow)}
                  >
                    {busy === workflow.key ? 'Running…' : 'Run now'}
                  </button>
                  <button
                    type="button"
                    className="btn !py-1 !text-xs"
                    disabled={busy === workflow.key}
                    onClick={() => onToggle(workflow)}
                  >
                    {workflow.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button type="button" className="btn !py-1 !text-xs" onClick={() => onExpand(workflow)}>
                    History
                  </button>
                </div>
              </div>

              {expanded === workflow.id && (
                <div className="mt-3 rounded-lg border border-[--color-border] bg-[--color-deep] p-3 animate-rise">
                  {!runs[workflow.id] ? (
                    <Spinner />
                  ) : runs[workflow.id]!.length === 0 ? (
                    <p className="text-xs text-[--color-faint]">Aucune exécution enregistrée.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {runs[workflow.id]!.map((run) => (
                        <li key={run.id} className="flex items-center justify-between gap-3 text-xs">
                          <span
                            className={
                              run.status === 'success'
                                ? 'text-emerald-300'
                                : run.status === 'failure'
                                  ? 'text-rose-300'
                                  : 'text-sky-300'
                            }
                          >
                            {run.status}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[--color-faint]">
                            {run.error ?? JSON.stringify(run.output ?? {}).slice(0, 120)}
                          </span>
                          <span className="text-[--color-faint]">{relativeTime(run.startedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
