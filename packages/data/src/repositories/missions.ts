import type {
  Mission,
  MissionId,
  MissionPlan,
  MissionPriority,
  MissionResult,
  MissionStatus,
  MissionTask,
  StagePrecondition,
  TaskId,
  TaskStatus,
} from '@atlas/contracts';
import { canTransition } from '@atlas/contracts';
import { id, missionCode, nowIso, notFound, invalidState } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

interface MissionRow {
  id: string;
  code: string;
  title: string;
  objective: string;
  context: string;
  status: MissionStatus;
  priority: MissionPriority;
  created_by: string;
  plan: string | null;
  progress: number;
  result: string | null;
  error: string | null;
  tags: string;
  parent_id: string | null;
  department_key: string | null;
  token_budget: number | null;
  replan_count: number;
  tokens_used: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

const toMission = (row: MissionRow): Mission => ({
  id: row.id,
  code: row.code,
  title: row.title,
  objective: row.objective,
  context: fromJson<Record<string, unknown>>(row.context, {}),
  status: row.status,
  priority: row.priority,
  createdBy: row.created_by as Mission['createdBy'],
  plan: fromJson<MissionPlan | null>(row.plan, null),
  progress: row.progress,
  result: fromJson<MissionResult | null>(row.result, null),
  error: row.error,
  tags: fromJson<string[]>(row.tags, []),
  parentId: row.parent_id,
  departmentKey: row.department_key,
  tokenBudget: row.token_budget,
  replanCount: row.replan_count ?? 0,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  updatedAt: row.updated_at,
});

interface TaskRow {
  id: string;
  mission_id: string;
  ref: string;
  seq: number;
  title: string;
  agent_key: string;
  action: string;
  instruction: string;
  input: string;
  output: string | null;
  status: TaskStatus;
  depends_on: string;
  preconditions: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  tokens_used: number;
  duration_ms: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

const toTask = (row: TaskRow): MissionTask => ({
  id: row.id,
  missionId: row.mission_id,
  ref: row.ref,
  seq: row.seq,
  title: row.title,
  agentKey: row.agent_key,
  action: row.action,
  instruction: row.instruction,
  input: fromJson<Record<string, unknown>>(row.input, {}),
  output: fromJson<Record<string, unknown> | null>(row.output, null),
  status: row.status,
  dependsOn: fromJson<string[]>(row.depends_on, []),
  preconditions: fromJson<StagePrecondition[]>(row.preconditions, []),
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  error: row.error,
  tokensUsed: row.tokens_used,
  durationMs: row.duration_ms,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class MissionRepository {
  constructor(private readonly db: Db) {}

  // ─── Missions ───────────────────────────────────────────────────────────

  create(input: {
    title: string;
    objective: string;
    context?: Record<string, unknown>;
    priority?: MissionPriority;
    createdBy: string;
    tags?: string[];
    parentId?: MissionId | null;
    departmentKey?: string | null;
    tokenBudget?: number | null;
  }): Mission {
    const now = nowIso();
    const row: MissionRow = {
      id: id('msn'),
      code: missionCode(),
      title: input.title,
      objective: input.objective,
      context: toJson(input.context ?? {}),
      status: 'created',
      priority: input.priority ?? 'normal',
      created_by: input.createdBy,
      plan: null,
      progress: 0,
      result: null,
      error: null,
      tags: toJson(input.tags ?? []),
      parent_id: input.parentId ?? null,
      department_key: input.departmentKey ?? null,
      token_budget: input.tokenBudget ?? null,
      replan_count: 0,
      tokens_used: 0,
      created_at: now,
      started_at: null,
      finished_at: null,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO missions (id, code, title, objective, context, status, priority, created_by,
                               plan, progress, result, error, tags, parent_id, department_key, token_budget,
                               replan_count, tokens_used,
                               created_at, started_at, finished_at, updated_at)
         VALUES (@id, @code, @title, @objective, @context, @status, @priority, @created_by,
                 @plan, @progress, @result, @error, @tags, @parent_id, @department_key, @token_budget,
                 @replan_count, @tokens_used,
                 @created_at, @started_at, @finished_at, @updated_at)`,
      )
      .run(row);
    return toMission(row);
  }

  get(missionId: MissionId): Mission | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as
      | MissionRow
      | undefined;
    return row ? toMission(row) : null;
  }

  require(missionId: MissionId): Mission {
    const mission = this.get(missionId);
    if (!mission) throw notFound(`Mission '${missionId}'`);
    return mission;
  }

  list(options: {
    status?: MissionStatus;
    search?: string;
    limit: number;
    offset: number;
  }): { items: Mission[]; total: number } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (options.status) {
      where.push('status = @status');
      params.status = options.status;
    }
    if (options.search) {
      where.push('(title LIKE @search OR objective LIKE @search OR code LIKE @search)');
      params.search = `%${options.search}%`;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM missions ${clause}`).get(params) as { n: number }
    ).n;

    const items = (
      this.db
        .prepare(`SELECT * FROM missions ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: options.limit, offset: options.offset }) as MissionRow[]
    ).map(toMission);

    return { items, total };
  }

  listByStatus(...statuses: MissionStatus[]): Mission[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT * FROM missions WHERE status IN (${placeholders}) ORDER BY created_at`)
        .all(...statuses) as MissionRow[]
    ).map(toMission);
  }

  /**
   * Applies a lifecycle transition, rejecting illegal moves.
   *
   * Centralising this is what keeps the state machine honest: no caller can
   * push a mission from `archived` back into `running` by writing a column.
   */
  transition(
    missionId: MissionId,
    to: MissionStatus,
    patch: {
      plan?: MissionPlan | null;
      result?: MissionResult | null;
      error?: string | null;
      progress?: number;
    } = {},
  ): Mission {
    const current = this.require(missionId);
    if (current.status !== to && !canTransition(current.status, to)) {
      throw invalidState(`Mission ${current.code} cannot move from '${current.status}' to '${to}'`);
    }

    const now = nowIso();
    const startedAt = to === 'running' && !current.startedAt ? now : current.startedAt;
    const finishedAt = ['completed', 'validated', 'failed', 'archived'].includes(to)
      ? (current.finishedAt ?? now)
      : current.finishedAt;

    this.db
      .prepare(
        `UPDATE missions SET
           status = @status,
           plan = COALESCE(@plan, plan),
           result = COALESCE(@result, result),
           error = @error,
           progress = COALESCE(@progress, progress),
           started_at = @started_at,
           finished_at = @finished_at,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: missionId,
        status: to,
        plan: patch.plan !== undefined ? toJson(patch.plan) : null,
        result: patch.result !== undefined ? toJson(patch.result) : null,
        error: patch.error !== undefined ? patch.error : current.error,
        progress: patch.progress ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        now,
      });

    return this.require(missionId);
  }

  /**
   * Records a plan without touching the lifecycle.
   *
   * Planning and status are separate concerns: a mission recovered mid-flight
   * needs a plan while already `running`, and forcing it back through
   * `planned` would be an illegal transition.
   */
  savePlan(missionId: MissionId, plan: MissionPlan): void {
    this.db
      .prepare('UPDATE missions SET plan = ?, updated_at = ? WHERE id = ?')
      .run(toJson(plan), nowIso(), missionId);
  }

  /**
   * Replaces the mission's context.
   *
   * Used to store the department brief once Hermes has read the objective, so a
   * mission resumed after a restart does not pay to have it read again — and
   * cannot end up with a second, differently-worded reading of the same request.
   */
  setContext(missionId: MissionId, context: Record<string, unknown>): void {
    this.db
      .prepare('UPDATE missions SET context = ?, updated_at = ? WHERE id = ?')
      .run(toJson(context), nowIso(), missionId);
  }

  setProgress(missionId: MissionId, progress: number): void {
    this.db
      .prepare('UPDATE missions SET progress = ?, updated_at = ? WHERE id = ?')
      .run(Math.max(0, Math.min(1, progress)), nowIso(), missionId);
  }

  addTokens(missionId: MissionId, tokens: number): void {
    if (tokens <= 0) return;
    this.db
      .prepare('UPDATE missions SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?')
      .run(tokens, nowIso(), missionId);
  }

  /** Bumps and returns the replan counter, so replanning stays bounded. */
  incrementReplanCount(missionId: MissionId): number {
    this.db
      .prepare('UPDATE missions SET replan_count = replan_count + 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), missionId);
    return this.require(missionId).replanCount;
  }

  tokensUsed(missionId: MissionId): number {
    const row = this.db.prepare('SELECT tokens_used AS t FROM missions WHERE id = ?').get(missionId) as
      | { t: number }
      | undefined;
    return row?.t ?? 0;
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────

  /** Replaces the task set for a mission — called once planning completes. */
  replaceTasks(
    missionId: MissionId,
    tasks: Array<{
      ref: string;
      title: string;
      agentKey: string;
      action: string;
      instruction: string;
      input: Record<string, unknown>;
      dependsOn: string[];
      preconditions?: StagePrecondition[];
      maxAttempts: number;
    }>,
  ): MissionTask[] {
    const now = nowIso();

    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mission_tasks WHERE mission_id = ?').run(missionId);
      const insert = this.db.prepare(
        `INSERT INTO mission_tasks (id, mission_id, ref, seq, title, agent_key, action, instruction,
                                    input, status, depends_on, preconditions, attempts, max_attempts,
                                    tokens_used, duration_ms, created_at, updated_at)
         VALUES (@id, @mission_id, @ref, @seq, @title, @agent_key, @action, @instruction,
                 @input, @status, @depends_on, @preconditions, 0, @max_attempts, 0, 0, @now, @now)`,
      );

      tasks.forEach((task, index) => {
        insert.run({
          id: id('tsk'),
          mission_id: missionId,
          ref: task.ref,
          seq: index,
          title: task.title,
          agent_key: task.agentKey,
          action: task.action,
          instruction: task.instruction,
          input: toJson(task.input),
          // A task with no dependencies is immediately dispatchable.
          status: task.dependsOn.length === 0 ? 'ready' : 'pending',
          depends_on: toJson(task.dependsOn),
          preconditions: toJson(task.preconditions ?? []),
          max_attempts: task.maxAttempts,
          now,
        });
      });
    });

    write();
    return this.tasksFor(missionId);
  }

  /**
   * Replaces only the steps that have not finished, preserving completed work.
   *
   * This is what makes replanning cheap: a mission that failed at step 3 keeps
   * steps 1–2 and their outputs, and Hermes only re-decides the remainder.
   * New steps are appended after the highest existing sequence number so the
   * mission's history stays readable in order.
   */
  replaceUnfinishedTasks(
    missionId: MissionId,
    tasks: Array<{
      ref: string;
      title: string;
      agentKey: string;
      action: string;
      instruction: string;
      input: Record<string, unknown>;
      dependsOn: string[];
      preconditions?: StagePrecondition[];
      maxAttempts: number;
    }>,
  ): MissionTask[] {
    const now = nowIso();

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM mission_tasks
           WHERE mission_id = ? AND status IN ('pending','ready','failed','cancelled','skipped')`,
        )
        .run(missionId);

      const maxSeq =
        (
          this.db
            .prepare('SELECT COALESCE(MAX(seq), -1) AS n FROM mission_tasks WHERE mission_id = ?')
            .get(missionId) as { n: number }
        ).n + 1;

      const surviving = new Set(
        (
          this.db
            .prepare('SELECT ref FROM mission_tasks WHERE mission_id = ?')
            .all(missionId) as Array<{ ref: string }>
        ).map((r) => r.ref),
      );

      const insert = this.db.prepare(
        `INSERT INTO mission_tasks (id, mission_id, ref, seq, title, agent_key, action, instruction,
                                    input, status, depends_on, preconditions, attempts, max_attempts,
                                    tokens_used, duration_ms, created_at, updated_at)
         VALUES (@id, @mission_id, @ref, @seq, @title, @agent_key, @action, @instruction,
                 @input, @status, @depends_on, @preconditions, 0, @max_attempts, 0, 0, @now, @now)`,
      );

      tasks.forEach((task, index) => {
        // A new step may depend on a step that survived, or on another new
        // step; anything else is dropped rather than left dangling.
        const deps = task.dependsOn.filter(
          (ref) => surviving.has(ref) || tasks.some((t) => t.ref === ref),
        );
        insert.run({
          id: id('tsk'),
          mission_id: missionId,
          ref: task.ref,
          seq: maxSeq + index,
          title: task.title,
          agent_key: task.agentKey,
          action: task.action,
          instruction: task.instruction,
          input: toJson(task.input),
          status: deps.length === 0 ? 'ready' : 'pending',
          depends_on: toJson(deps),
          preconditions: toJson(task.preconditions ?? []),
          max_attempts: task.maxAttempts,
          now,
        });
        surviving.add(task.ref);
      });
    });

    write();
    return this.tasksFor(missionId);
  }

  tasksFor(missionId: MissionId): MissionTask[] {
    return (
      this.db
        .prepare('SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY seq')
        .all(missionId) as TaskRow[]
    ).map(toTask);
  }

  getTask(taskId: TaskId): MissionTask | null {
    const row = this.db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : null;
  }

  setTaskStatus(
    taskId: TaskId,
    status: TaskStatus,
    patch: {
      output?: Record<string, unknown> | null;
      error?: string | null;
      tokensUsed?: number;
      durationMs?: number;
      incrementAttempt?: boolean;
    } = {},
  ): MissionTask {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE mission_tasks SET
           status = @status,
           output = COALESCE(@output, output),
           error = @error,
           attempts = attempts + @attempt_delta,
           tokens_used = tokens_used + @tokens,
           duration_ms = CASE WHEN @duration > 0 THEN @duration ELSE duration_ms END,
           started_at = CASE WHEN @status = 'running' AND started_at IS NULL THEN @now ELSE started_at END,
           finished_at = CASE WHEN @status IN ('succeeded','failed','skipped','cancelled')
                              THEN @now ELSE finished_at END,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: taskId,
        status,
        output: patch.output !== undefined ? toJson(patch.output) : null,
        error: patch.error ?? null,
        attempt_delta: patch.incrementAttempt ? 1 : 0,
        tokens: patch.tokensUsed ?? 0,
        duration: patch.durationMs ?? 0,
        now,
      });

    const task = this.getTask(taskId);
    if (!task) throw notFound(`Task '${taskId}'`);
    return task;
  }

  /**
   * Promotes `pending` tasks whose dependencies have all succeeded, and skips
   * those whose dependencies failed. Returns the tasks now ready to dispatch.
   */
  refreshReadyTasks(missionId: MissionId): MissionTask[] {
    const tasks = this.tasksFor(missionId);
    const byRef = new Map(tasks.map((t) => [t.ref, t]));
    const nowReady: MissionTask[] = [];

    for (const task of tasks) {
      if (task.status !== 'pending') continue;

      const deps = task.dependsOn.map((ref) => byRef.get(ref));

      // Only a *succeeded* dependency satisfies a step. A skipped dependency
      // produced no output, so anything downstream of it is equally starved —
      // treating `skipped` as satisfied would stop the cascade after one level
      // and run a step without the input it declared it needed.
      // A dependency that no longer exists is doomed too, rather than blocking
      // for ever and hanging the dispatch loop.
      const doomed = deps.some((d) => !d || ['failed', 'cancelled', 'skipped'].includes(d.status));
      const blocked = deps.some((d) => d && d.status !== 'succeeded');

      if (doomed) {
        nowReady.push(
          this.setTaskStatus(task.id, 'skipped', {
            error: 'Skipped because a prerequisite step did not succeed',
          }),
        );
        continue;
      }
      if (!blocked) {
        nowReady.push(this.setTaskStatus(task.id, 'ready'));
      }
    }

    return nowReady.filter((t) => t.status === 'ready');
  }

  /** Fraction of tasks in a terminal state — the mission's real progress. */
  computeProgress(missionId: MissionId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('succeeded','failed','skipped','cancelled') THEN 1 ELSE 0 END) AS done
         FROM mission_tasks WHERE mission_id = ?`,
      )
      .get(missionId) as { total: number; done: number | null };

    if (!row.total) return 0;
    return Math.round(((row.done ?? 0) / row.total) * 100) / 100;
  }

  /** Re-queues unfinished tasks so an interrupted mission can resume (SRS §6.10). */
  requeueUnfinishedTasks(missionId: MissionId): number {
    return this.db
      .prepare(
        `UPDATE mission_tasks
         SET status = CASE WHEN json_array_length(depends_on) = 0 THEN 'ready' ELSE 'pending' END,
             updated_at = ?
         WHERE mission_id = ? AND status = 'running'`,
      )
      .run(nowIso(), missionId).changes;
  }

  /**
   * Remet en file les étapes nommées, pour reprendre une mission interrompue.
   *
   * Les étapes déjà réussies ne sont jamais touchées : leur travail est acquis,
   * et le repayer n'apprendrait rien. C'est ce qui sépare une reprise d'un
   * redémarrage — LIVE-001 avait produit trois candidats allemands sourcés
   * avant d'être arrêté par une garde, et recommencer aurait signifié payer une
   * seconde fois pour redécouvrir exactement les mêmes.
   *
   * Une étape sans dépendance repart `ready`, les autres `pending` : c'est le
   * même calcul qu'au premier lancement, et il laisse le répartiteur décider
   * de l'ordre plutôt que de le figer ici.
   */
  resetTasksForResume(missionId: MissionId, refs: string[]): number {
    if (refs.length === 0) return 0;
    const placeholders = refs.map(() => '?').join(',');
    return this.db
      .prepare(
        `UPDATE mission_tasks
         SET status = CASE WHEN json_array_length(depends_on) = 0 THEN 'ready' ELSE 'pending' END,
             error = NULL,
             attempts = 0,
             started_at = NULL,
             finished_at = NULL,
             updated_at = ?
         WHERE mission_id = ? AND ref IN (${placeholders}) AND status != 'succeeded'`,
      )
      .run(nowIso(), missionId, ...refs).changes;
  }

  /** Ajuste le plafond en jetons d'une mission — utilisé par la reprise. */
  setTokenBudget(missionId: MissionId, tokenBudget: number): void {
    this.db
      .prepare('UPDATE missions SET token_budget = ?, updated_at = ? WHERE id = ?')
      .run(tokenBudget, nowIso(), missionId);
  }

  cancelPendingTasks(missionId: MissionId, reason: string): number {
    return this.db
      .prepare(
        `UPDATE mission_tasks SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ?
         WHERE mission_id = ? AND status IN ('pending','ready','running')`,
      )
      .run(reason, nowIso(), nowIso(), missionId).changes;
  }

  // ─── Aggregates for the dashboard ───────────────────────────────────────

  countsByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM missions GROUP BY status').all() as
      Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  countSince(since: string, statuses: MissionStatus[]): number {
    const placeholders = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM missions WHERE finished_at >= ? AND status IN (${placeholders})`,
      )
      .get(since, ...statuses) as { n: number };
    return row.n;
  }

  tokensSince(since: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(tokens_used), 0) AS n FROM missions WHERE created_at >= ?')
      .get(since) as { n: number };
    return row.n;
  }

  tokensTotal(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(tokens_used), 0) AS n FROM missions').get() as {
      n: number;
    };
    return row.n;
  }

  /** Recently failed tasks — the raw material for the evolution loop. */
  recentFailures(limit = 50): MissionTask[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM mission_tasks WHERE status = 'failed'
           ORDER BY finished_at DESC LIMIT ?`,
        )
        .all(limit) as TaskRow[]
    ).map(toTask);
  }
}
