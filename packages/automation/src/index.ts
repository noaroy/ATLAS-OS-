import type { EventType, MissionId, Workflow, WorkflowTrigger } from '@atlas/contracts';
import type { AtlasConfig, EventBus, Logger } from '@atlas/core';
import { describeError, nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { AutomationGateway } from '@atlas/agents';
import { N8nClient } from './n8n-client.ts';
import { nextRun, isValidCron } from './cron.ts';

export * from './cron.ts';
export { N8nClient, type N8nConfig, type N8nWorkflowSummary } from './n8n-client.ts';

export type InternalHandler = (
  payload: Record<string, unknown>,
  missionId: MissionId | null,
) => Promise<Record<string, unknown>>;

export interface AutomationDeps {
  repos: Repositories;
  events: EventBus;
  config: AtlasConfig;
  logger: Logger;
}

/**
 * The automation layer (SRS §2.12, §5.12).
 *
 * Hermes decides; this executes. Two kinds of workflow share one registry:
 *   • external — delegated to n8n over its webhook
 *   • internal — ATLAS's own maintenance jobs (backups, consolidation, review)
 *
 * Keeping both behind one interface means the founder sees a single list of
 * "things that run on their own", and internal jobs get the same scheduling,
 * history, and failure handling as external ones.
 */
export class AutomationService implements AutomationGateway {
  #log: Logger;
  #n8n: N8nClient | null;
  #internal = new Map<string, InternalHandler>();
  #unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: AutomationDeps) {
    this.#log = deps.logger.child({ scope: 'automation' });
    this.#n8n = deps.config.n8n.enabled
      ? new N8nClient(
          {
            baseUrl: deps.config.n8n.baseUrl,
            apiKey: deps.config.n8n.apiKey,
            webhookSecret: deps.config.n8n.webhookSecret,
          },
          deps.logger,
        )
      : null;
  }

  get n8nEnabled(): boolean {
    return this.#n8n !== null;
  }

  get n8n(): N8nClient | null {
    return this.#n8n;
  }

  /**
   * Registers an in-process job. Internal workflows are marked with the
   * `atlas.` prefix so the console can distinguish them from n8n workflows.
   */
  registerInternal(
    key: string,
    definition: { name: string; description: string; trigger: WorkflowTrigger },
    handler: InternalHandler,
  ): void {
    this.#internal.set(key, handler);

    const existing = this.deps.repos.workflows.getByKey(key);
    this.deps.repos.workflows.upsert({
      key,
      name: definition.name,
      description: definition.description,
      externalId: null,
      webhookPath: null,
      trigger: definition.trigger,
      // Preserve a founder's decision to disable a job across restarts.
      enabled: existing?.enabled ?? true,
      nextRunAt: computeNextRun(definition.trigger),
    });
  }

  listWorkflowKeys(): string[] {
    return this.deps.repos.workflows
      .list()
      .filter((w) => w.enabled)
      .map((w) => w.key);
  }

  listWorkflows(): Workflow[] {
    return this.deps.repos.workflows.list();
  }

  /**
   * Runs a workflow and records the attempt.
   *
   * Failures are returned rather than thrown: a workflow failing is an
   * operational event ATLAS should record and surface, not an exception that
   * takes down the caller's mission.
   */
  async trigger(
    workflowKey: string,
    payload: Record<string, unknown>,
    missionId: MissionId | null = null,
  ): Promise<{ status: 'success' | 'failure'; output: Record<string, unknown> | null; error?: string }> {
    const workflow = this.deps.repos.workflows.getByKey(workflowKey);
    if (!workflow) {
      return { status: 'failure', output: null, error: `No workflow registered as "${workflowKey}"` };
    }
    if (!workflow.enabled) {
      return { status: 'failure', output: null, error: `Workflow "${workflowKey}" is disabled` };
    }

    const run = this.deps.repos.workflows.startRun({ workflowId: workflow.id, missionId, payload });

    this.deps.events.publish({
      type: 'workflow.triggered',
      severity: 'info',
      source: 'automation',
      missionId,
      message: `Running workflow "${workflow.name}"`,
      payload: { workflow: workflowKey, runId: run.id },
    });

    try {
      const output = await this.#execute(workflow, payload, missionId);
      this.deps.repos.workflows.finishRun(run.id, { status: 'success', output });

      this.deps.events.publish({
        type: 'workflow.completed',
        severity: 'success',
        source: 'automation',
        missionId,
        message: `Workflow "${workflow.name}" completed`,
        payload: { workflow: workflowKey, runId: run.id },
      });

      return { status: 'success', output };
    } catch (err) {
      const error = describeError(err);
      this.deps.repos.workflows.finishRun(run.id, { status: 'failure', error });

      this.deps.events.publish({
        type: 'workflow.failed',
        severity: 'error',
        source: 'automation',
        missionId,
        message: `Workflow "${workflow.name}" failed: ${error}`,
        payload: { workflow: workflowKey, runId: run.id, error },
      });

      this.deps.repos.ops.raiseAlertOnce({
        level: 'warning',
        title: `Automation failed: ${workflow.name}`,
        detail: error,
        source: 'automation',
      });

      return { status: 'failure', output: null, error };
    }
  }

  async #execute(
    workflow: Workflow,
    payload: Record<string, unknown>,
    missionId: MissionId | null,
  ): Promise<Record<string, unknown>> {
    const internal = this.#internal.get(workflow.key);
    if (internal) return internal(payload, missionId);

    if (!this.#n8n) {
      throw new Error('This workflow runs in n8n, but the n8n integration is disabled');
    }
    if (!workflow.webhookPath) {
      throw new Error(`Workflow "${workflow.key}" has no webhook path configured`);
    }

    return this.#n8n.triggerWebhook(workflow.webhookPath, {
      ...payload,
      atlas: { missionId, workflow: workflow.key, triggeredAt: nowIso() },
    });
  }

  /**
   * Scheduler tick (SRS §2.12).
   *
   * Called by the runtime supervisor. Every due workflow is rescheduled
   * *before* it runs, so a slow or failing job can never re-fire in a loop.
   */
  async tick(): Promise<number> {
    const due = this.deps.repos.workflows.due();
    if (due.length === 0) return 0;

    for (const workflow of due) {
      this.deps.repos.workflows.setNextRun(workflow.id, computeNextRun(workflow.trigger));
      void this.trigger(workflow.key, { trigger: 'schedule', firedAt: nowIso() }, null);
    }
    return due.length;
  }

  /** Wires event-triggered workflows to the bus (SRS §5.9). */
  subscribeToEvents(): void {
    if (this.#unsubscribe) return;

    this.#unsubscribe = this.deps.events.on('*', async (event) => {
      if (event.source === 'automation') return; // never let a workflow trigger itself
      const matches = this.deps.repos.workflows.listByEventTrigger(event.type as EventType);
      for (const workflow of matches) {
        void this.trigger(
          workflow.key,
          { trigger: 'event', event: { type: event.type, message: event.message, payload: event.payload } },
          event.missionId,
        );
      }
    });
  }

  /** Recomputes `next_run_at` for every scheduled workflow — run at boot. */
  rescheduleAll(): void {
    for (const workflow of this.deps.repos.workflows.list()) {
      if (workflow.trigger.type !== 'schedule') continue;
      this.deps.repos.workflows.setNextRun(workflow.id, computeNextRun(workflow.trigger));
    }
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}

function computeNextRun(trigger: WorkflowTrigger): string | null {
  if (trigger.type !== 'schedule') return null;
  if (!isValidCron(trigger.cron)) return null;
  return nextRun(trigger.cron)?.toISOString() ?? null;
}
export { guardLiveAutomation, type LiveAutomationRequest, type LiveAutomationVerdict } from './live-guard.ts';
