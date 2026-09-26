import { id, nowIso, canTransitionTask, DEPARTMENT_ORDER } from '@atlas/core';
import type { TaskStatus, ProviderHealth, ProviderState, RetrySource } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * La file de travail durable.
 *
 * Une seule chose compte vraiment ici : deux processus ne doivent jamais
 * prendre la même tâche. Le reste — priorités, dépendances, statistiques — est
 * du confort ; ceci est une garantie.
 *
 * Elle est tenue par la condition d'écriture, pas par une vérification
 * préalable. La lecture qui désigne la candidate ne décide de rien : c'est
 * l'`UPDATE … WHERE task_id = ? AND status = ?` qui attribue la tâche, et son
 * nombre de lignes modifiées qui dit si on l'a eue. Deux workers qui visent la
 * même ligne au même instant sont départagés par SQLite ; l'un d'eux modifie
 * zéro ligne, et le sait.
 *
 * La différence n'est pas théorique : elle apparaît exactement quand deux
 * daemons tournent, c'est-à-dire au moment où l'on croyait avoir doublé la
 * capacité.
 */

export interface TaskRow {
  taskId: string;
  taskType: string;
  department: string;
  workerType: string;
  priority: number;
  status: TaskStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  availableAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastHeartbeatAt: string | null;
  parentTaskId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  chainId: string | null;
  chainDepth: number;
  fingerprint: string | null;
}

export interface CreateTaskInput {
  taskType: string;
  department: string;
  workerType: string;
  priority?: number;
  payload?: Record<string, unknown>;
  availableAt?: string;
  maxAttempts?: number;
  parentTaskId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  estimatedCost?: number | null;
  metadata?: Record<string, unknown>;
  dependsOn?: readonly string[];
  /** La chaine a laquelle la tache appartient. Sa racine, si elle en ouvre une. */
  chainId?: string | null;
  chainDepth?: number;
  fingerprint?: string | null;
}

export interface ClaimResult {
  task: TaskRow | null;
  reason: string;
}

const parse = (value: unknown, fallback: Record<string, unknown> | null = {}) => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return fallback;
  }
};

function toTask(r: Record<string, unknown>): TaskRow {
  return {
    taskId: r.task_id as string,
    taskType: r.task_type as string,
    department: r.department as string,
    workerType: r.worker_type as string,
    priority: r.priority as number,
    status: r.status as TaskStatus,
    payload: parse(r.payload_json) ?? {},
    result: parse(r.result_json, null),
    createdAt: r.created_at as string,
    availableAt: r.available_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    attemptCount: r.attempt_count as number,
    maxAttempts: r.max_attempts as number,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseUntil: (r.lease_until as string | null) ?? null,
    lastHeartbeatAt: (r.last_heartbeat_at as string | null) ?? null,
    parentTaskId: (r.parent_task_id as string | null) ?? null,
    correlationId: (r.correlation_id as string | null) ?? null,
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
    estimatedCost: (r.estimated_cost as number | null) ?? null,
    actualCost: (r.actual_cost as number | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    metadata: parse(r.metadata_json) ?? {},
    chainId: (r.chain_id as string | null) ?? null,
    chainDepth: (r.chain_depth as number | null) ?? 0,
    fingerprint: (r.fingerprint as string | null) ?? null,
  };
}

/**
 * L'ordre des départements, traduit pour SQL.
 *
 * Construit depuis la constante partagée : deux listes qu'il faudrait garder
 * synchrones à la main finiraient par diverger, et la divergence se verrait le
 * jour où un client urgent passerait après une tâche de maintenance.
 */
const DEPARTMENT_CASE = `CASE department ${DEPARTMENT_ORDER.map(
  (name, index) => `WHEN '${name}' THEN ${index}`,
).join(' ')} ELSE ${DEPARTMENT_ORDER.length} END`;

function toWorkspace(r: Record<string, unknown>) {
  return {
    workspaceId: r.workspace_id as string,
    taskId: r.task_id as string,
    baseCommit: r.base_commit as string,
    branch: (r.branch as string | null) ?? null,
    path: r.path as string,
    state: r.state as string,
    diffHash: (r.diff_hash as string | null) ?? null,
    filesChanged: (r.files_changed as number | null) ?? 0,
    diffLines: (r.diff_lines as number | null) ?? 0,
    createdAt: r.created_at as string,
  };
}

export class TaskRepository {
  constructor(private readonly db: Db) {}

  // --- Création -----------------------------------------------------------

  create(input: CreateTaskInput): { task: TaskRow; created: boolean } {
    if (input.idempotencyKey) {
      const existing = this.byIdempotencyKey(input.idempotencyKey);
      // Rendue plutôt que jetée : un planificateur qui repasse toutes les
      // minutes recrée la même tâche horaire, et ce n'est pas une anomalie.
      if (existing) return { task: existing, created: false };
    }

    const now = nowIso();
    const taskId = id('tsk');
    const status: TaskStatus = (input.dependsOn?.length ?? 0) > 0 ? 'WAITING_DEPENDENCY' : 'QUEUED';

    this.db
      .prepare(
        `INSERT INTO tasks
           (task_id, task_type, department, worker_type, priority, status, payload_json,
            created_at, available_at, attempt_count, max_attempts, parent_task_id,
            correlation_id, idempotency_key, estimated_cost, metadata_json,
            chain_id, chain_depth, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        input.taskType,
        input.department,
        input.workerType,
        input.priority ?? 0,
        status,
        JSON.stringify(input.payload ?? {}),
        now,
        input.availableAt ?? now,
        input.maxAttempts ?? 3,
        input.parentTaskId ?? null,
        input.correlationId ?? null,
        input.idempotencyKey ?? null,
        input.estimatedCost ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.chainId ?? taskId,
        input.chainDepth ?? 0,
        input.fingerprint ?? null,
      );

    for (const dependency of input.dependsOn ?? []) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(taskId, dependency, now);
    }

    this.recordTransition({ taskId, from: null, to: status, actor: 'file', reason: 'création' });
    return { task: this.byId(taskId)!, created: true };
  }

  byId(taskId: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? toTask(row) : null;
  }

  byIdempotencyKey(key: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? toTask(row) : null;
  }

  // --- Prise atomique -----------------------------------------------------

  /**
   * Prendre une tâche, ou repartir les mains vides.
   *
   * En deux temps, délibérément. Un seul `UPDATE` avec sous-requête suffirait à
   * garantir l'unicité, mais il ne dirait pas dans quel état la tâche se
   * trouvait avant — et l'historique écrirait alors « QUEUED → RUNNING » pour
   * une tâche qui venait de RETRY_SCHEDULED. Un journal approximatif sur le
   * seul chemin qui sert à comprendre une panne ne vaut pas l'économie d'une
   * requête.
   *
   * La sûreté ne repose pas sur la lecture : elle repose sur `AND status = ?`.
   */
  claim(input: {
    owner: string;
    leaseMs: number;
    workerTypes: readonly string[];
    now?: string;
  }): ClaimResult {
    const now = input.now ?? nowIso();
    const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const placeholders = input.workerTypes.map(() => '?').join(', ');

    // On désigne d'abord la candidate, avec son état exact. Cette lecture ne
    // décide de rien : c'est l'écriture qui suit, gardée par `AND status = ?`,
    // qui attribue la tâche. Si un autre worker l'a prise entre-temps, l'UPDATE
    // touche zéro ligne et on le sait.
    const candidate = this.db
      .prepare(
        `SELECT t.task_id, t.status FROM tasks t
          WHERE t.status IN ('QUEUED', 'RETRY_SCHEDULED')
            AND t.available_at <= ?
            AND t.worker_type IN (${placeholders})
            AND NOT EXISTS (
                  SELECT 1 FROM task_dependencies d
                    JOIN tasks p ON p.task_id = d.depends_on_task_id
                   WHERE d.task_id = t.task_id AND p.status <> 'DONE'
                )
          ORDER BY ${DEPARTMENT_CASE} ASC,
                   t.priority DESC,
                   t.available_at ASC,
                   t.created_at ASC
          LIMIT 1`,
      )
      .get(now, ...input.workerTypes) as { task_id: string; status: TaskStatus } | undefined;

    if (!candidate) return { task: null, reason: 'aucune tâche prenable' };

    const outcome = this.db
      .prepare(
        `UPDATE tasks
            SET status = 'RUNNING',
                lease_owner = ?,
                lease_until = ?,
                started_at = COALESCE(started_at, ?),
                last_heartbeat_at = ?,
                attempt_count = attempt_count + 1
          WHERE task_id = ? AND status = ?`,
      )
      .run(input.owner, leaseUntil, now, now, candidate.task_id, candidate.status);

    if (outcome.changes === 0) {
      // Un autre worker a été plus rapide. Ce n'est pas une anomalie : c'est
      // exactement ce que la garde doit produire.
      return { task: null, reason: 'tâche prise par un autre worker entre-temps' };
    }

    const claimed = this.byId(candidate.task_id)!;
    this.recordTransition({
      taskId: claimed.taskId,
      from: candidate.status,
      to: 'RUNNING',
      actor: input.owner,
      attempt: claimed.attemptCount,
      reason: `bail jusqu'au ${leaseUntil}`,
    });
    return { task: claimed, reason: 'prise' };
  }

  /**
   * Renouveler le bail d'une tâche en cours.
   *
   * Le propriétaire est vérifié dans le `WHERE` : un worker qui a perdu sa
   * tâche — bail expiré, tâche reprise ailleurs — ne doit pas pouvoir la
   * reprendre en prolongeant un bail qui ne lui appartient plus.
   */
  heartbeat(taskId: string, owner: string, leaseMs: number): boolean {
    const now = nowIso();
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const outcome = this.db
      .prepare(
        `UPDATE tasks SET lease_until = ?, last_heartbeat_at = ?
          WHERE task_id = ? AND lease_owner = ? AND status = 'RUNNING'`,
      )
      .run(leaseUntil, now, taskId, owner);
    return outcome.changes === 1;
  }

  /**
   * Les tâches dont le worker s'est tu.
   *
   * On ne récupère jamais une tâche dont le bail court encore : un worker lent
   * n'est pas un worker mort, et reprendre son travail produirait exactement le
   * double travail que la file existe pour éviter.
   */
  recoverStaleLeases(actor: string, now = nowIso()): Array<{ taskId: string; to: TaskStatus }> {
    const stale = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE status = 'RUNNING' AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .all(now) as Array<Record<string, unknown>>;

    const recovered: Array<{ taskId: string; to: TaskStatus }> = [];
    for (const row of stale) {
      const task = toTask(row);
      const exhausted = task.attemptCount >= task.maxAttempts;
      const to: TaskStatus = exhausted ? 'FAILED' : 'RETRY_SCHEDULED';
      this.transition({
        taskId: task.taskId,
        to,
        actor,
        reason: exhausted
          ? `bail expiré, ${task.attemptCount}/${task.maxAttempts} tentatives épuisées`
          : `bail expiré le ${task.leaseUntil ?? 'jamais posé'} : reprise programmée`,
        patch: {
          lease_owner: null,
          lease_until: null,
          available_at: now,
          ...(exhausted
            ? { finished_at: now, error_code: 'LEASE_EXPIRED', error_message: 'worker interrompu' }
            : {}),
        },
      });
      recovered.push({ taskId: task.taskId, to });
    }
    return recovered;
  }

  // --- Transitions --------------------------------------------------------

  /**
   * Changer l'état d'une tâche, si la machine l'autorise.
   *
   * Le refus est rendu, pas jeté : une transition impossible est souvent une
   * course normale — deux boucles qui constatent la même chose — et non une
   * erreur de programmation.
   */
  transition(input: {
    taskId: string;
    to: TaskStatus;
    actor: string;
    reason?: string | null;
    patch?: Record<string, string | number | null>;
  }): { applied: boolean; reason: string } {
    const task = this.byId(input.taskId);
    if (!task) return { applied: false, reason: 'tâche inconnue' };

    const check = canTransitionTask(task.status, input.to);
    if (!check.allowed) return { applied: false, reason: check.reason };

    const patch = { status: input.to, ...(input.patch ?? {}) };
    const assignments = Object.keys(patch).map((column) => `${column} = ?`).join(', ');
    this.db
      .prepare(`UPDATE tasks SET ${assignments} WHERE task_id = ? AND status = ?`)
      .run(...Object.values(patch), input.taskId, task.status);

    this.recordTransition({
      taskId: input.taskId,
      from: task.status,
      to: input.to,
      actor: input.actor,
      attempt: task.attemptCount,
      reason: input.reason ?? check.reason,
    });
    return { applied: true, reason: check.reason };
  }

  private recordTransition(input: {
    taskId: string;
    from: TaskStatus | null;
    to: TaskStatus;
    actor: string;
    attempt?: number | null;
    reason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_transitions
           (id, task_id, from_status, to_status, reason, actor, attempt, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('ttr'), input.taskId, input.from, input.to,
        input.reason ?? null, input.actor, input.attempt ?? null, nowIso(),
      );
  }

  historyFor(taskId: string): Array<{
    from: string | null; to: string; reason: string | null; actor: string; occurredAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT from_status, to_status, reason, actor, occurred_at FROM task_transitions
          WHERE task_id = ? ORDER BY occurred_at ASC, rowid ASC`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      from: (r.from_status as string | null) ?? null,
      to: r.to_status as string,
      reason: (r.reason as string | null) ?? null,
      actor: r.actor as string,
      occurredAt: r.occurred_at as string,
    }));
  }

  // --- Issues -------------------------------------------------------------

  complete(taskId: string, result: Record<string, unknown>, actor: string, costUsd?: number | null) {
    return this.transition({
      taskId,
      to: 'DONE',
      actor,
      reason: 'terminée',
      patch: {
        result_json: JSON.stringify(result),
        finished_at: nowIso(),
        lease_owner: null,
        lease_until: null,
        actual_cost: costUsd ?? null,
      },
    });
  }

  /**
   * Un échec, qui devient une reprise tant qu'il reste des tentatives.
   *
   * Le compteur a déjà été incrémenté par la prise : on compare donc à ce qui a
   * été consommé, pas à ce qui va l'être.
   */
  fail(input: {
    taskId: string;
    actor: string;
    errorCode: string;
    errorMessage: string;
    retryDelayMs?: number;
  }): { applied: boolean; reason: string; to: TaskStatus } {
    const task = this.byId(input.taskId);
    if (!task) return { applied: false, reason: 'tâche inconnue', to: 'FAILED' };

    const exhausted = task.attemptCount >= task.maxAttempts;
    const to: TaskStatus = exhausted ? 'FAILED' : 'RETRY_SCHEDULED';
    const availableAt = new Date(Date.now() + (input.retryDelayMs ?? 60_000)).toISOString();

    const outcome = this.transition({
      taskId: input.taskId,
      to,
      actor: input.actor,
      reason: exhausted
        ? `${task.attemptCount}/${task.maxAttempts} tentatives : abandon`
        : `tentative ${task.attemptCount}/${task.maxAttempts} échouée, reprise au ${availableAt}`,
      patch: {
        error_code: input.errorCode,
        error_message: input.errorMessage,
        lease_owner: null,
        lease_until: null,
        available_at: exhausted ? task.availableAt : availableAt,
        ...(exhausted ? { finished_at: nowIso() } : {}),
      },
    });
    return { ...outcome, to };
  }

  /**
   * La mise en pause pour quota : la tentative consommée est rendue.
   *
   * Une limitation n'est pas une faute de la tâche. Lui faire payer une
   * tentative reviendrait à condamner un travail valide après trois
   * indisponibilités passagères — ce qui, sur un système qui tourne des
   * semaines, arrive.
   */
  pauseForQuota(input: {
    taskId: string;
    actor: string;
    provider: string;
    retryAt: string;
    reason: string;
  }): { applied: boolean; reason: string } {
    const task = this.byId(input.taskId);
    if (!task) return { applied: false, reason: 'tâche inconnue' };
    return this.transition({
      taskId: input.taskId,
      to: 'PAUSED_QUOTA',
      actor: input.actor,
      reason: `${input.provider} : ${input.reason}`,
      patch: {
        available_at: input.retryAt,
        lease_owner: null,
        lease_until: null,
        attempt_count: Math.max(0, task.attemptCount - 1),
        error_code: 'PROVIDER_UNAVAILABLE',
        error_message: input.reason,
      },
    });
  }

  pauseForBudget(input: { taskId: string; actor: string; reason: string; retryAt: string }) {
    const task = this.byId(input.taskId);
    if (!task) return { applied: false, reason: 'tâche inconnue' };
    return this.transition({
      taskId: input.taskId,
      to: 'PAUSED_BUDGET',
      actor: input.actor,
      reason: input.reason,
      patch: {
        available_at: input.retryAt,
        lease_owner: null,
        lease_until: null,
        attempt_count: Math.max(0, task.attemptCount - 1),
        error_code: 'BUDGET_EXHAUSTED',
        error_message: input.reason,
      },
    });
  }

  /**
   * Garer une tâche jusqu'à ce qu'une personne tranche.
   *
   * Le motif est écrit *aussi* dans `error_message`, et non seulement dans la
   * transition. La file humaine le lit là : tant qu'il n'y figurait pas, une
   * tâche garée s'y affichait « décision requise » — une phrase qui n'apprend
   * rien à qui doit décider, alors que la raison exacte existait à deux tables
   * de distance.
   */
  waitForHuman(taskId: string, actor: string, reason: string, errorCode = 'WAITING_HUMAN') {
    return this.transition({
      taskId,
      to: 'WAITING_HUMAN',
      actor,
      reason,
      patch: {
        lease_owner: null,
        lease_until: null,
        error_code: errorCode,
        error_message: reason,
      },
    });
  }

  /**
   * Rendre à la file les pauses dont l'échéance est atteinte.
   *
   * `available_at` porte l'échéance, quelle qu'en soit la cause : c'est ce qui
   * permet à une seule requête de relever aussi bien une pause quota qu'une
   * pause budget.
   */
  resumeEligible(actor: string, now = nowIso()): string[] {
    const rows = this.db
      .prepare(
        `SELECT task_id FROM tasks
          WHERE status IN ('PAUSED_QUOTA', 'PAUSED_BUDGET') AND available_at <= ?`,
      )
      .all(now) as Array<{ task_id: string }>;
    const resumed: string[] = [];
    for (const row of rows) {
      const outcome = this.transition({
        taskId: row.task_id,
        to: 'QUEUED',
        actor,
        reason: 'échéance de reprise atteinte',
        patch: { error_code: null, error_message: null },
      });
      if (outcome.applied) resumed.push(row.task_id);
    }
    return resumed;
  }

  /** Débloquer ce qui attendait une dépendance désormais satisfaite. */
  releaseSatisfiedDependencies(actor: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.task_id FROM tasks t
          WHERE t.status = 'WAITING_DEPENDENCY'
            AND NOT EXISTS (
                  SELECT 1 FROM task_dependencies d
                    JOIN tasks p ON p.task_id = d.depends_on_task_id
                   WHERE d.task_id = t.task_id AND p.status <> 'DONE'
                )`,
      )
      .all() as Array<{ task_id: string }>;
    const released: string[] = [];
    for (const row of rows) {
      const outcome = this.transition({
        taskId: row.task_id, to: 'QUEUED', actor, reason: 'dépendances satisfaites',
      });
      if (outcome.applied) released.push(row.task_id);
    }
    return released;
  }

  /** Les tâches dont une dépendance a définitivement échoué. */
  blockedByFailedDependency(): Array<{ taskId: string; dependsOn: string }> {
    const rows = this.db
      .prepare(
        `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
           JOIN tasks p ON p.task_id = d.depends_on_task_id
           JOIN tasks t ON t.task_id = d.task_id
          WHERE p.status IN ('FAILED', 'CANCELLED') AND t.status = 'WAITING_DEPENDENCY'`,
      )
      .all() as Array<{ task_id: string; depends_on_task_id: string }>;
    return rows.map((r) => ({ taskId: r.task_id, dependsOn: r.depends_on_task_id }));
  }

  // --- Lecture ------------------------------------------------------------

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  list(options: { status?: string; limit?: number } = {}): TaskRow[] {
    const rows = options.status
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(options.status, options.limit ?? 50) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
          .all(options.limit ?? 50) as Array<Record<string, unknown>>);
    return rows.map(toTask);
  }

  oldestQueued(): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status IN ('QUEUED', 'RETRY_SCHEDULED')
          ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  nextScheduled(now = nowIso()): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE status IN ('QUEUED', 'RETRY_SCHEDULED', 'PAUSED_QUOTA', 'PAUSED_BUDGET')
            AND available_at > ?
          ORDER BY available_at ASC LIMIT 1`,
      )
      .get(now) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  /**
   * La dernière tâche d'un type qui s'est terminée — réussie ou abandonnée.
   *
   * Une reprise programmée n'est pas terminée : elle n'a pas de `finished_at`
   * et ne compte pas ici. C'est ce qui permet de lire, pour un cycle
   * périodique, ce que sa dernière tentative aboutie a réellement constaté.
   */
  lastFinishedOfType(taskType: string): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
          WHERE task_type = ? AND finished_at IS NOT NULL AND status IN ('DONE', 'FAILED')
          ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(taskType) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  lastCompleted(): TaskRow | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'DONE' ORDER BY finished_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  completedSince(iso: string): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'DONE' AND finished_at >= ?")
      .all(iso) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  /**
   * Dans combien de temps quelque chose deviendra prenable.
   *
   * C'est ce qui permet au daemon de dormir juste ce qu'il faut plutôt que de
   * se réveiller toutes les secondes pour constater qu'il n'y a rien à faire.
   */
  msUntilNextWork(now = nowIso()): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(available_at) AS next FROM tasks
          WHERE status IN ('QUEUED', 'RETRY_SCHEDULED', 'PAUSED_QUOTA', 'PAUSED_BUDGET')`,
      )
      .get() as { next: string | null };
    if (!row.next) return null;
    return Math.max(0, Date.parse(row.next) - Date.parse(now));
  }

  // --- Santé des fournisseurs ---------------------------------------------

  recordProviderHealth(input: {
    provider: string;
    state: ProviderState;
    reason?: string | null;
    retryAt?: string | null;
    retrySource?: RetrySource;
  }): ProviderHealth {
    const observedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO provider_health_events
           (id, provider, state, reason, retry_at, retry_source, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('phe'), input.provider, input.state, input.reason ?? null,
        input.retryAt ?? null, input.retrySource ?? 'NONE', observedAt,
      );
    return {
      provider: input.provider,
      state: input.state,
      reason: input.reason ?? null,
      retryAt: input.retryAt ?? null,
      retrySource: input.retrySource ?? 'NONE',
      observedAt,
    };
  }

  providerHealth(provider: string): ProviderHealth | null {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_health_events WHERE provider = ?
          ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(provider) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      provider: row.provider as string,
      state: row.state as ProviderState,
      reason: (row.reason as string | null) ?? null,
      retryAt: (row.retry_at as string | null) ?? null,
      retrySource: (row.retry_source as RetrySource) ?? 'NONE',
      observedAt: row.observed_at as string,
    };
  }

  /** Depuis quand un fournisseur est indisponible, en millisecondes. */
  providerDowntimeMs(provider: string, since: string): number {
    const rows = this.db
      .prepare(
        `SELECT state, observed_at FROM provider_health_events
          WHERE provider = ? AND observed_at >= ? ORDER BY observed_at ASC`,
      )
      .all(provider, since) as Array<{ state: string; observed_at: string }>;
    let total = 0;
    let downSince: number | null = null;
    for (const row of rows) {
      const at = Date.parse(row.observed_at);
      if (row.state === 'AVAILABLE') {
        if (downSince !== null) total += at - downSince;
        downSince = null;
      } else if (downSince === null) {
        downSince = at;
      }
    }
    if (downSince !== null) total += Date.now() - downSince;
    return total;
  }

  // --- Opérations externes ------------------------------------------------

  /**
   * Réserver une opération externe avant de la faire.
   *
   * La généralisation de ce qui protégeait l'envoi commercial. Même principe,
   * même conséquence assumée : un plantage entre la réservation et la
   * confirmation laisse l'opération bloquée plutôt que de risquer un doublon.
   *
   * `blockedBy` : une autre réservation qui, si elle existe, interdit
   * celle-ci. Vérifiée par la même instruction que l'insertion — il n'y a pas
   * d'instant où l'une est lue et l'autre pas encore écrite.
   */
  reserveExternalOperation(input: {
    idempotencyKey: string;
    kind: string;
    taskId?: string | null;
    target?: string | null;
    summary?: string | null;
    claimedBy: string;
    blockedBy?: string | null;
  }): { reserved: boolean; confirmed: boolean; externalRef: string | null; blocked: boolean; reason: string } {
    // L'insertion est la question : deux processus qui réservent ensemble ne
    // peuvent pas gagner tous deux, et le perdant l'apprend par une réponse,
    // pas par une exception de contrainte.
    const inserted = this.db
      .prepare(
        `INSERT INTO external_operations
           (idempotency_key, kind, task_id, target, summary, claimed_at, claimed_by)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM external_operations WHERE idempotency_key = ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        input.idempotencyKey, input.kind, input.taskId ?? null,
        input.target ?? null, input.summary ?? null, nowIso(), input.claimedBy,
        input.blockedBy ?? null,
      );
    if (inserted.changes === 1) {
      return { reserved: true, confirmed: false, externalRef: null, blocked: false, reason: 'place réservée' };
    }

    const own = this.db
      .prepare('SELECT 1 FROM external_operations WHERE idempotency_key = ?')
      .get(input.idempotencyKey);
    if (!own) {
      return {
        reserved: false, confirmed: false, externalRef: null, blocked: true,
        reason: `interdite : ${input.blockedBy} est déjà réservée`,
      };
    }

    const done = this.db
      .prepare(
        `SELECT external_ref, occurred_at FROM external_operation_events
          WHERE idempotency_key = ? AND phase = 'CONFIRMED' LIMIT 1`,
      )
      .get(input.idempotencyKey) as
      | { external_ref: string | null; occurred_at: string }
      | undefined;
    return {
      reserved: false,
      confirmed: Boolean(done),
      externalRef: done?.external_ref ?? null,
      blocked: false,
      reason: done
        ? `déjà exécutée le ${done.occurred_at}`
        : 'une tentative est déjà engagée : reprise interdite sans décision humaine',
    };
  }

  /**
   * Créer une tâche et la lier à une opération, ou ne rien créer.
   *
   * Dans une seule transaction IMMEDIATE : la réservation est relue, la tâche
   * créée (ou retrouvée par sa clé d'idempotence), la réservation écrite et
   * confirmée. Deux processus qui reçoivent la même demande au même instant —
   * ou deux versions d'une même demande — sont sérialisés par SQLite : le
   * second trouve la réservation du premier et ne crée rien.
   */
  createClaimedTask(input: CreateTaskInput, claim: {
    idempotencyKey: string;
    kind: string;
    target?: string | null;
    summary?: string | null;
    claimedBy: string;
  }): { claimed: true; task: TaskRow; created: boolean } | { claimed: false; taskId: string | null } {
    const write = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT task_id FROM external_operations WHERE idempotency_key = ?')
        .get(claim.idempotencyKey) as { task_id: string | null } | undefined;
      if (existing) return { claimed: false as const, taskId: existing.task_id ?? null };

      const { task, created } = this.create(input);
      const reserved = this.reserveExternalOperation({ ...claim, taskId: task.taskId });
      if (!reserved.reserved) throw new Error(`réservation ${claim.idempotencyKey} perdue dans sa propre transaction`);
      this.confirmExternalOperation({ idempotencyKey: claim.idempotencyKey, phase: 'CONFIRMED', externalRef: task.taskId });
      return { claimed: true as const, task, created };
    });
    return write.immediate();
  }

  confirmExternalOperation(input: {
    idempotencyKey: string;
    phase: 'CONFIRMED' | 'FAILED';
    externalRef?: string | null;
    error?: string | null;
  }): { recorded: boolean; reason: string } {
    try {
      this.db
        .prepare(
          `INSERT INTO external_operation_events
             (id, idempotency_key, phase, external_ref, error, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id('eoe'), input.idempotencyKey, input.phase,
          input.externalRef ?? null, input.error ?? null, nowIso(),
        );
      return { recorded: true, reason: `issue ${input.phase} consignée` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toUpperCase().includes('UNIQUE')) {
        return { recorded: false, reason: 'une exécution réussie est déjà consignée' };
      }
      throw error;
    }
  }

  /**
   * Relire une réservation, sans rien écrire.
   *
   * `reserveExternalOperation` répond aussi à la question « existe-t-elle ? »,
   * mais en réservant quand la réponse est non. Un appelant qui doit décider
   * avant d'agir — le pont contrôleur retrouve la tâche d'une issue — a besoin
   * de la lecture seule.
   */
  externalOperation(idempotencyKey: string): {
    idempotencyKey: string; kind: string; taskId: string | null; target: string | null;
    summary: string | null; claimedAt: string; confirmed: boolean; externalRef: string | null; failed: boolean;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM external_operations WHERE idempotency_key = ?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    const done = this.db
      .prepare(
        `SELECT external_ref FROM external_operation_events
          WHERE idempotency_key = ? AND phase = 'CONFIRMED' LIMIT 1`,
      )
      .get(idempotencyKey) as { external_ref: string | null } | undefined;
    const failed = this.db
      .prepare(
        `SELECT 1 FROM external_operation_events
          WHERE idempotency_key = ? AND phase = 'FAILED' LIMIT 1`,
      )
      .get(idempotencyKey);
    return {
      idempotencyKey: row.idempotency_key as string,
      kind: row.kind as string,
      taskId: (row.task_id as string | null) ?? null,
      target: (row.target as string | null) ?? null,
      summary: (row.summary as string | null) ?? null,
      claimedAt: row.claimed_at as string,
      confirmed: Boolean(done),
      externalRef: done?.external_ref ?? null,
      failed: Boolean(failed),
    };
  }

  /** Les réservations d'un genre, les plus récentes d'abord. Lecture seule. */
  externalOperationsOfKind(kind: string, limit = 20): Array<{
    idempotencyKey: string; taskId: string | null; target: string | null; summary: string | null; claimedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, task_id, target, summary, claimed_at FROM external_operations
          WHERE kind = ? ORDER BY claimed_at DESC LIMIT ?`,
      )
      .all(kind, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key as string,
      taskId: (r.task_id as string | null) ?? null,
      target: (r.target as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      claimedAt: r.claimed_at as string,
    }));
  }

  // --- Chaines ------------------------------------------------------------

  /** Toutes les taches d'une chaine, y compris sa racine. */
  chainTasks(chainId: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE chain_id = ? ORDER BY created_at ASC')
      .all(chainId) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  /**
   * Une empreinte identique existe-t-elle deja dans la chaine ?
   *
   * C'est la garde contre le renvoi de balle : deux modeles qui se demandent
   * mutuellement la meme chose sous une formulation legerement differente
   * produisent la meme empreinte, et le second exemplaire ne se cree pas.
   */
  fingerprintInChain(chainId: string, fingerprint: string): TaskRow | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE chain_id = ? AND fingerprint = ? LIMIT 1')
      .get(chainId, fingerprint) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  }

  /** Les tâches nées d'une autre. Sert à ne pas retraiter un parent. */
  childrenOf(parentTaskId: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC')
      .all(parentTaskId) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  /** Ce que la chaine a coute jusqu'ici, et ce qu'on sait de ce cout. */
  chainCost(chainId: string): { knownUsd: number; unknownCalls: number; calls: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN cost_basis = 'KNOWN' THEN cost_usd ELSE 0 END), 0) AS known,
                SUM(CASE WHEN cost_basis = 'UNKNOWN_PRICE' THEN 1 ELSE 0 END) AS unknown
           FROM ai_calls WHERE chain_id = ?`,
      )
      .get(chainId) as { calls: number; known: number; unknown: number | null };
    return { knownUsd: row.known, unknownCalls: row.unknown ?? 0, calls: row.calls };
  }

  /**
   * Les appels au tarif inconnu d'une chaine, un par un.
   *
   * `chainCost` les compte ; un appelant qui doit decider si chacun est
   * justifie — Claude Code sur abonnement n'a pas de prix a l'appel — a besoin
   * de savoir lesquels, et pour quelle tache.
   */
  unknownCostCalls(chainId: string): Array<{ taskId: string | null; provider: string; model: string }> {
    const rows = this.db
      .prepare(
        `SELECT task_id, provider, model FROM ai_calls
          WHERE chain_id = ? AND cost_basis = 'UNKNOWN_PRICE' ORDER BY occurred_at ASC`,
      )
      .all(chainId) as Array<{ task_id: string | null; provider: string; model: string }>;
    return rows.map((r) => ({ taskId: r.task_id ?? null, provider: r.provider, model: r.model }));
  }

  /** Depuis combien de minutes la chaine tourne. */
  chainRuntimeMinutes(chainId: string): number {
    const row = this.db
      .prepare('SELECT MIN(created_at) AS start FROM tasks WHERE chain_id = ?')
      .get(chainId) as { start: string | null };
    if (!row.start) return 0;
    return Math.round((Date.now() - Date.parse(row.start)) / 60_000);
  }

  // --- Usage des modeles --------------------------------------------------

  recordAiCall(input: {
    taskId?: string | null;
    chainId?: string | null;
    provider: string;
    model: string;
    capability?: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    costUsd?: number | null;
    costBasis: string;
    durationMs?: number | null;
    outcome: string;
    errorCode?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ai_calls
           (id, task_id, chain_id, provider, model, capability, input_tokens, output_tokens,
            cache_read_tokens, cost_usd, cost_basis, duration_ms, outcome, error_code, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('aic'), input.taskId ?? null, input.chainId ?? null, input.provider, input.model,
        input.capability ?? null, input.inputTokens, input.outputTokens,
        input.cacheReadTokens ?? 0, input.costUsd ?? null, input.costBasis,
        input.durationMs ?? null, input.outcome, input.errorCode ?? null, nowIso(),
      );
  }

  /**
   * Ce qu'un fournisseur a consomme depuis une date.
   *
   * `unknownCostCalls` est rendu a part : un total qui additionnerait des
   * appels au tarif inconnu comme s'ils valaient zero serait plus trompeur que
   * l'absence de total.
   */
  aiUsageSince(iso: string, provider?: string): {
    calls: number; inputTokens: number; outputTokens: number;
    knownCostUsd: number; unknownCostCalls: number;
  } {
    const sql = (filter: string) =>
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(CASE WHEN cost_basis = 'KNOWN' THEN cost_usd ELSE 0 END), 0) AS known,
              SUM(CASE WHEN cost_basis = 'UNKNOWN_PRICE' THEN 1 ELSE 0 END) AS unknown
         FROM ai_calls WHERE occurred_at >= ?${filter}`;
    const row = (provider
      ? this.db.prepare(sql(' AND provider = ?')).get(iso, provider)
      : this.db.prepare(sql('')).get(iso)) as {
      calls: number; input: number; output: number; known: number; unknown: number | null;
    };
    return {
      calls: row.calls,
      inputTokens: row.input,
      outputTokens: row.output,
      knownCostUsd: row.known,
      unknownCostCalls: row.unknown ?? 0,
    };
  }

  /**
   * La depense des workers ventilee, depuis une date.
   *
   * Le departement n'est pas porte par l'appel mais par la tache qui l'a
   * declenche : il faut la jointure. Un appel sans tache rattachee garde le
   * label « hors tache » plutot que d'etre range sous un departement au
   * hasard.
   */
  aiBreakdownSince(
    iso: string,
    axis: 'provider' | 'model' | 'department',
  ): Array<{
    label: string; calls: number; inputTokens: number; outputTokens: number;
    knownCostUsd: number; unknownCostCalls: number; lastAt: string | null;
  }> {
    const select = axis === 'department'
      ? "COALESCE(t.department, 'hors tache')"
      : `a.${axis}`;
    const from = axis === 'department'
      ? 'ai_calls a LEFT JOIN tasks t ON t.task_id = a.task_id'
      : 'ai_calls a';

    const rows = this.db
      .prepare(
        `SELECT ${select}                                       AS label,
                COUNT(*)                                        AS calls,
                COALESCE(SUM(a.input_tokens), 0)                AS input_tokens,
                COALESCE(SUM(a.output_tokens), 0)               AS output_tokens,
                COALESCE(SUM(CASE WHEN a.cost_basis = 'KNOWN' THEN a.cost_usd ELSE 0 END), 0) AS known_cost,
                SUM(CASE WHEN a.cost_basis = 'UNKNOWN_PRICE' THEN 1 ELSE 0 END) AS unknown_calls,
                MAX(a.occurred_at)                              AS last_at
           FROM ${from}
          WHERE a.occurred_at >= ?
          GROUP BY label
          ORDER BY known_cost DESC, calls DESC`,
      )
      .all(iso) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      label: (row.label as string | null) ?? 'inconnu',
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      knownCostUsd: Number(row.known_cost),
      unknownCostCalls: Number(row.unknown_calls ?? 0),
      lastAt: (row.last_at as string | null) ?? null,
    }));
  }

  /** La depense des workers jour par jour. */
  aiDailySince(iso: string): Array<{
    day: string; calls: number; knownCostUsd: number; unknownCostCalls: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT substr(occurred_at, 1, 10)                       AS day,
                COUNT(*)                                        AS calls,
                COALESCE(SUM(CASE WHEN cost_basis = 'KNOWN' THEN cost_usd ELSE 0 END), 0) AS known_cost,
                SUM(CASE WHEN cost_basis = 'UNKNOWN_PRICE' THEN 1 ELSE 0 END) AS unknown_calls
           FROM ai_calls
          WHERE occurred_at >= ?
          GROUP BY day
          ORDER BY day ASC`,
      )
      .all(iso) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      day: row.day as string,
      calls: Number(row.calls),
      knownCostUsd: Number(row.known_cost),
      unknownCostCalls: Number(row.unknown_calls ?? 0),
    }));
  }

  lastAiCall(provider: string, outcome?: string): { occurredAt: string; outcome: string } | null {
    const row = (outcome
      ? this.db.prepare(
          `SELECT occurred_at, outcome FROM ai_calls
            WHERE provider = ? AND outcome = ? ORDER BY occurred_at DESC LIMIT 1`,
        ).get(provider, outcome)
      : this.db.prepare(
          `SELECT occurred_at, outcome FROM ai_calls
            WHERE provider = ? ORDER BY occurred_at DESC LIMIT 1`,
        ).get(provider)) as { occurred_at: string; outcome: string } | undefined;
    return row ? { occurredAt: row.occurred_at, outcome: row.outcome } : null;
  }

  // --- Verrou d'ecriture sur le depot -------------------------------------

  /**
   * Prendre le verrou, ou repartir sans.
   *
   * Un verrou dont le bail a expire est repris : un agent qui meurt en le
   * tenant ne doit pas bloquer le depot jusqu'a ce qu'une personne s'en
   * apercoive. La reprise est une suppression suivie d'une insertion, dans la
   * meme transaction -- jamais une modification, pour que deux processus ne
   * puissent pas se croire proprietaires ensemble.
   */
  acquireRepoLock(input: {
    lockKey: string;
    taskId?: string | null;
    owner: string;
    mode: 'WRITE' | 'READ';
    leaseMs: number;
  }): { acquired: boolean; heldBy: string | null; reason: string } {
    const now = nowIso();
    const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();

    const take = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT owner, lease_until FROM repo_locks WHERE lock_key = ?')
        .get(input.lockKey) as { owner: string; lease_until: string } | undefined;

      if (existing && existing.lease_until > now) {
        return { acquired: false, heldBy: existing.owner, reason: `tenu par ${existing.owner}` };
      }
      if (existing) {
        this.db.prepare('DELETE FROM repo_locks WHERE lock_key = ?').run(input.lockKey);
      }
      this.db
        .prepare(
          `INSERT INTO repo_locks (lock_key, task_id, owner, mode, acquired_at, lease_until)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.lockKey, input.taskId ?? null, input.owner, input.mode, now, leaseUntil);
      return {
        acquired: true,
        heldBy: input.owner,
        reason: existing ? 'bail precedent expire, verrou repris' : 'verrou pris',
      };
    });
    return take();
  }

  renewRepoLock(lockKey: string, owner: string, leaseMs: number): boolean {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const outcome = this.db
      .prepare('UPDATE repo_locks SET lease_until = ? WHERE lock_key = ? AND owner = ?')
      .run(leaseUntil, lockKey, owner);
    return outcome.changes === 1;
  }

  releaseRepoLock(lockKey: string, owner: string): boolean {
    const outcome = this.db
      .prepare('DELETE FROM repo_locks WHERE lock_key = ? AND owner = ?')
      .run(lockKey, owner);
    return outcome.changes === 1;
  }

  repoLockHolder(lockKey: string): { owner: string; leaseUntil: string } | null {
    const row = this.db
      .prepare('SELECT owner, lease_until FROM repo_locks WHERE lock_key = ?')
      .get(lockKey) as { owner: string; lease_until: string } | undefined;
    return row ? { owner: row.owner, leaseUntil: row.lease_until } : null;
  }

  // --- Espaces de travail d'ingenierie ------------------------------------

  /**
   * Ouvrir un espace de travail pour une tache.
   *
   * L'index unique partiel garantit qu'une tache n'en a qu'un seul de mutable :
   * deux espaces pour une meme tache produiraient deux diffs concurrents dont
   * aucun ne serait celui qu'on a relu.
   */
  openWorkspace(input: {
    workspaceId: string;
    taskId: string;
    baseCommit: string;
    branch?: string | null;
    path: string;
  }): { opened: boolean; reason: string } {
    try {
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO engineering_workspaces
             (workspace_id, task_id, base_commit, branch, path, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
        )
        .run(
          input.workspaceId, input.taskId, input.baseCommit,
          input.branch ?? null, input.path, now, now,
        );
      return { opened: true, reason: 'espace ouvert' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toUpperCase().includes('UNIQUE')) {
        return { opened: false, reason: 'cette tache a deja un espace de travail ouvert' };
      }
      throw error;
    }
  }

  setWorkspaceState(input: {
    workspaceId: string;
    state: string;
    diffHash?: string | null;
    filesChanged?: number;
    diffLines?: number;
  }): void {
    this.db
      .prepare(
        `UPDATE engineering_workspaces
            SET state = ?, updated_at = ?,
                diff_hash = COALESCE(?, diff_hash),
                files_changed = COALESCE(?, files_changed),
                diff_lines = COALESCE(?, diff_lines),
                cleaned_at = CASE WHEN ? IN ('CLEANED', 'ABANDONED') THEN ? ELSE cleaned_at END
          WHERE workspace_id = ?`,
      )
      .run(
        input.state, nowIso(), input.diffHash ?? null,
        input.filesChanged ?? null, input.diffLines ?? null,
        input.state, nowIso(), input.workspaceId,
      );
  }

  workspaceFor(taskId: string): {
    workspaceId: string; taskId: string; baseCommit: string; branch: string | null;
    path: string; state: string; diffHash: string | null;
    filesChanged: number; diffLines: number; createdAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM engineering_workspaces WHERE task_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? toWorkspace(row) : null;
  }

  workspacesInState(state: string): Array<ReturnType<typeof toWorkspace>> {
    const rows = this.db
      .prepare('SELECT * FROM engineering_workspaces WHERE state = ? ORDER BY created_at ASC')
      .all(state) as Array<Record<string, unknown>>;
    return rows.map(toWorkspace);
  }

  workspaceCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM engineering_workspaces GROUP BY state')
      .all() as Array<{ state: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  // --- Artefacts d'ingenierie ---------------------------------------------

  /**
   * Conserver ce qui a ete produit, a part du resultat de tache.
   *
   * Un diff entier dans un resultat de tache serait relu par le modele suivant
   * a chaque fois qu'il lit ce resultat. La reference coute quelques octets ;
   * le contenu, des milliers de jetons.
   */
  saveArtifact(input: {
    taskId: string;
    workspaceId?: string | null;
    kind: string;
    content: string;
  }): string {
    const artifactId = id('art');
    this.db
      .prepare(
        `INSERT INTO engineering_artifacts
           (artifact_id, task_id, workspace_id, kind, content, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId, input.taskId, input.workspaceId ?? null, input.kind,
        input.content, Buffer.byteLength(input.content, 'utf8'), nowIso(),
      );
    return artifactId;
  }

  artifact(artifactId: string): { kind: string; content: string; bytes: number } | null {
    const row = this.db
      .prepare('SELECT kind, content, bytes FROM engineering_artifacts WHERE artifact_id = ?')
      .get(artifactId) as { kind: string; content: string; bytes: number } | undefined;
    return row ?? null;
  }

  artifactsFor(taskId: string): Array<{ artifactId: string; kind: string; bytes: number }> {
    const rows = this.db
      .prepare(
        `SELECT artifact_id, kind, bytes FROM engineering_artifacts
          WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<{ artifact_id: string; kind: string; bytes: number }>;
    return rows.map((r) => ({ artifactId: r.artifact_id, kind: r.kind, bytes: r.bytes }));
  }

  // --- Journal du daemon --------------------------------------------------

  startDaemonRun(host: string, pid: number): string {
    const runId = id('dmn');
    this.db
      .prepare('INSERT INTO daemon_runs (id, host, pid, started_at) VALUES (?, ?, ?, ?)')
      .run(runId, host, pid, nowIso());
    return runId;
  }

  stopDaemonRun(runId: string, reason: string): void {
    this.db
      .prepare('UPDATE daemon_runs SET stopped_at = ?, stop_reason = ? WHERE id = ?')
      .run(nowIso(), reason, runId);
  }

  /**
   * Ferme les tours restés ouverts par un processus qui n'a pas pu le dire
   * (coupure, kill). Appelé au démarrage suivant : l'historique dit alors
   * « arrêt non consigné », jamais « toujours en marche ».
   *
   * Bornée au même `host` : plusieurs daemons partagent cette table sur la
   * base canonique (le serveur principal, `atlas-engineer`, isolés l'un de
   * l'autre par conception). Sans cette borne, le démarrage de l'un fermait
   * le tour encore vivant de l'autre — relevé en production : le serveur
   * principal fermait le tour d'`atlas-engineer` à chacun de ses propres
   * redémarrages, alors que celui-ci continuait de battre un tour déjà classé
   * arrêté, invisible pour toujours à `externalRunnerAlive`.
   */
  closeStaleDaemonRuns(exceptRunId: string, host: string, reason = 'arrêt non consigné : reprise par un nouveau daemon'): number {
    return this.db
      .prepare('UPDATE daemon_runs SET stopped_at = ?, stop_reason = ? WHERE stopped_at IS NULL AND id != ? AND host = ?')
      .run(nowIso(), reason, exceptRunId, host).changes;
  }

  /** Le daemon date son tour : sans cette trace, un processus mort ressemble à un processus qui dort. */
  heartbeatDaemonRun(runId: string): void {
    this.db.prepare('UPDATE daemon_runs SET last_heartbeat_at = ? WHERE id = ?').run(nowIso(), runId);
  }

  /**
   * Les derniers tours, du plus récent au plus ancien, avec leur raison
   * d'arrêt : c'est elle qui dit si une reprise a fermé un arrêt non consigné.
   */
  daemonRuns(limit = 5): Array<{ id: string; startedAt: string; stoppedAt: string | null; stopReason: string | null; pid: number; host: string; lastHeartbeatAt: string | null }> {
    return (this.db
      .prepare('SELECT * FROM daemon_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>)
      .map((row) => ({
        id: row.id as string,
        startedAt: row.started_at as string,
        stoppedAt: (row.stopped_at as string | null) ?? null,
        stopReason: (row.stop_reason as string | null) ?? null,
        pid: row.pid as number,
        host: row.host as string,
        lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
      }));
  }

  lastDaemonRun(): { id: string; startedAt: string; stoppedAt: string | null; pid: number; host: string; lastHeartbeatAt: string | null } | null {
    const row = this.db
      .prepare('SELECT * FROM daemon_runs ORDER BY started_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row
      ? {
          id: row.id as string,
          startedAt: row.started_at as string,
          stoppedAt: (row.stopped_at as string | null) ?? null,
          pid: row.pid as number,
          host: row.host as string,
          lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
        }
      : null;
  }
}
