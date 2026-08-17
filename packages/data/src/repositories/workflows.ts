import type { Workflow, WorkflowRun, WorkflowTrigger } from '@atlas/contracts';
import { id, nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface WorkflowRow {
  id: string;
  key: string;
  name: string;
  description: string;
  external_id: string | null;
  webhook_path: string | null;
  trigger: string;
  enabled: number;
  last_run_at: string | null;
  last_status: 'success' | 'failure' | 'never' | null;
  run_count: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const toWorkflow = (row: WorkflowRow): Workflow => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  externalId: row.external_id,
  webhookPath: row.webhook_path,
  trigger: fromJson<WorkflowTrigger>(row.trigger, { type: 'manual' }),
  enabled: toBool(row.enabled),
  lastRunAt: row.last_run_at,
  lastStatus: row.last_status,
  runCount: row.run_count,
});

interface RunRow {
  id: string;
  workflow_id: string;
  mission_id: string | null;
  status: WorkflowRun['status'];
  input: string;
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toRun = (row: RunRow): WorkflowRun => ({
  id: row.id,
  workflowId: row.workflow_id,
  missionId: row.mission_id,
  status: row.status,
  input: fromJson<Record<string, unknown>>(row.input, {}),
  output: fromJson<Record<string, unknown> | null>(row.output, null),
  error: row.error,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  upsert(input: {
    key: string;
    name: string;
    description: string;
    externalId: string | null;
    webhookPath: string | null;
    trigger: WorkflowTrigger;
    enabled: boolean;
    nextRunAt?: string | null;
  }): Workflow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO workflows (id, key, name, description, external_id, webhook_path, trigger,
                                enabled, next_run_at, created_at, updated_at)
         VALUES (@id, @key, @name, @description, @external_id, @webhook_path, @trigger,
                 @enabled, @next_run_at, @now, @now)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           external_id = excluded.external_id,
           webhook_path = excluded.webhook_path,
           trigger = excluded.trigger,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: id('wfl'),
        key: input.key,
        name: input.name,
        description: input.description,
        external_id: input.externalId,
        webhook_path: input.webhookPath,
        trigger: toJson(input.trigger),
        enabled: fromBool(input.enabled),
        next_run_at: input.nextRunAt ?? null,
        now,
      });

    return this.getByKey(input.key)!;
  }

  getByKey(key: string): Workflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE key = ?').get(key) as
      | WorkflowRow
      | undefined;
    return row ? toWorkflow(row) : null;
  }

  get(workflowId: string): Workflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as
      | WorkflowRow
      | undefined;
    return row ? toWorkflow(row) : null;
  }

  require(workflowId: string): Workflow {
    const workflow = this.get(workflowId);
    if (!workflow) throw notFound(`Workflow '${workflowId}'`);
    return workflow;
  }

  list(): Workflow[] {
    return (this.db.prepare('SELECT * FROM workflows ORDER BY name').all() as WorkflowRow[]).map(
      toWorkflow,
    );
  }

  setEnabled(key: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE workflows SET enabled = ?, updated_at = ? WHERE key = ?')
      .run(fromBool(enabled), nowIso(), key);
  }

  delete(workflowId: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
  }

  /** Scheduled workflows whose next run is due. */
  due(nowIsoString = nowIso()): Workflow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM workflows
           WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
        )
        .all(nowIsoString) as WorkflowRow[]
    ).map(toWorkflow);
  }

  setNextRun(workflowId: string, nextRunAt: string | null): void {
    this.db.prepare('UPDATE workflows SET next_run_at = ? WHERE id = ?').run(nextRunAt, workflowId);
  }

  listByEventTrigger(eventType: string): Workflow[] {
    return this.list().filter((w) => w.enabled && w.trigger.type === 'event' && w.trigger.event === eventType);
  }

  // ─── Runs ───────────────────────────────────────────────────────────────

  startRun(input: {
    workflowId: string;
    missionId: string | null;
    payload: Record<string, unknown>;
  }): WorkflowRun {
    const row: RunRow = {
      id: id('wfr'),
      workflow_id: input.workflowId,
      mission_id: input.missionId,
      status: 'running',
      input: toJson(input.payload),
      output: null,
      error: null,
      started_at: nowIso(),
      finished_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, mission_id, status, input, output, error, started_at, finished_at)
         VALUES (@id, @workflow_id, @mission_id, @status, @input, @output, @error, @started_at, @finished_at)`,
      )
      .run(row);

    this.db
      .prepare('UPDATE workflows SET run_count = run_count + 1, last_run_at = ? WHERE id = ?')
      .run(row.started_at, input.workflowId);

    return toRun(row);
  }

  finishRun(
    runId: string,
    result: { status: 'success' | 'failure'; output?: Record<string, unknown> | null; error?: string | null },
  ): void {
    const now = nowIso();
    const run = this.db.prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?').get(runId) as
      | { workflow_id: string }
      | undefined;

    this.db
      .prepare('UPDATE workflow_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(result.status, toJson(result.output ?? null), result.error ?? null, now, runId);

    if (run) {
      this.db.prepare('UPDATE workflows SET last_status = ? WHERE id = ?').run(result.status, run.workflow_id);
    }
  }

  runsFor(workflowId: string, limit = 25): WorkflowRun[] {
    return (
      this.db
        .prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(workflowId, limit) as RunRow[]
    ).map(toRun);
  }

  countRunsSince(since: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE started_at >= ?').get(since) as {
        n: number;
      }
    ).n;
  }
}
