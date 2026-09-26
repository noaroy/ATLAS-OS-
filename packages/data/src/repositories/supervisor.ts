import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import type { TaskRepository, CreateTaskInput, TaskRow } from './tasks.ts';

/**
 * L'état du superviseur GPT : les objectifs autonomes et leurs revues.
 *
 * La file de tâches porte déjà le travail — qui fait quoi, dans quel état, avec
 * quel résultat. Ce dépôt ne porte que ce qu'elle ne sait pas dire : à quel
 * objectif une tâche appartient, ce que la revue en a conclu, et comment
 * l'objectif s'est terminé.
 *
 * Toutes les garanties d'unicité sont des écritures conditionnelles, jamais
 * des lectures préalables : deux sondeurs qui lisent la même tâche au même
 * instant sont départagés par SQLite, et le perdant l'apprend par un nombre de
 * lignes modifiées.
 */

export type ObjectiveStatus = 'ACTIVE' | 'COMPLETE' | 'BLOCKED';
export type SupervisorDecisionKind = 'COMPLETE' | 'NEXT_TASK' | 'CORRECT' | 'BLOCKED';

export interface ObjectiveSpec {
  allowed_paths: string[];
  test_commands: string[];
  acceptance_criteria: string[];
  constraints: string[];
  limits: Record<string, number>;
  repo_target: string | null;
}

export interface SupervisorObjective {
  objectiveId: string;
  rootTaskId: string;
  chainId: string;
  source: string;
  objective: string;
  spec: ObjectiveSpec;
  status: ObjectiveStatus;
  maxCycles: number;
  maxCorrections: number;
  maxCostUsd: number;
  deadlineAt: string;
  cycles: number;
  corrections: number;
  baseCommit: string | null;
  terminalCode: string | null;
  terminalReason: string | null;
  terminalReviewId: string | null;
  result: Record<string, unknown> | null;
  lastNote: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SupervisorReview {
  reviewId: string;
  objectiveId: string;
  taskId: string;
  cycle: number;
  state: 'RESERVED' | 'DECIDED';
  attempts: number;
  reservedBy: string;
  reservedAt: string;
  leaseUntil: string;
  reviewer: 'GPT' | 'GUARD' | null;
  decision: SupervisorDecisionKind | null;
  code: string | null;
  reason: string | null;
  decisionJson: Record<string, unknown> | null;
  diffHash: string | null;
  childTaskId: string | null;
  model: string | null;
  calls: number;
  costUsd: number | null;
  decidedAt: string | null;
}

const parse = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
};

function toObjective(r: Record<string, unknown>): SupervisorObjective {
  return {
    objectiveId: r.objective_id as string,
    rootTaskId: r.root_task_id as string,
    chainId: r.chain_id as string,
    source: r.source as string,
    objective: r.objective as string,
    spec: (parse(r.spec_json) ?? {}) as unknown as ObjectiveSpec,
    status: r.status as ObjectiveStatus,
    maxCycles: r.max_cycles as number,
    maxCorrections: r.max_corrections as number,
    maxCostUsd: r.max_cost_usd as number,
    deadlineAt: r.deadline_at as string,
    cycles: r.cycles as number,
    corrections: r.corrections as number,
    baseCommit: (r.base_commit as string | null) ?? null,
    terminalCode: (r.terminal_code as string | null) ?? null,
    terminalReason: (r.terminal_reason as string | null) ?? null,
    terminalReviewId: (r.terminal_review_id as string | null) ?? null,
    result: parse(r.result_json),
    lastNote: (r.last_note as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function toReview(r: Record<string, unknown>): SupervisorReview {
  return {
    reviewId: r.review_id as string,
    objectiveId: r.objective_id as string,
    taskId: r.task_id as string,
    cycle: r.cycle as number,
    state: r.state as SupervisorReview['state'],
    attempts: r.attempts as number,
    reservedBy: r.reserved_by as string,
    reservedAt: r.reserved_at as string,
    leaseUntil: r.lease_until as string,
    reviewer: (r.reviewer as SupervisorReview['reviewer']) ?? null,
    decision: (r.decision as SupervisorDecisionKind | null) ?? null,
    code: (r.code as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    decisionJson: parse(r.decision_json),
    diffHash: (r.diff_hash as string | null) ?? null,
    childTaskId: (r.child_task_id as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    calls: (r.calls as number | null) ?? 0,
    costUsd: (r.cost_usd as number | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
  };
}

export interface EnsureObjectiveInput {
  objectiveId: string;
  rootTaskId: string;
  chainId: string;
  source: string;
  objective: string;
  spec: ObjectiveSpec;
  maxCycles: number;
  maxCorrections: number;
  maxCostUsd: number;
  deadlineAt: string;
}

export type ReserveReviewResult =
  | { reserved: true; review: SupervisorReview; retaken: boolean }
  | { reserved: false; review: SupervisorReview | null; reason: string };

export interface DecideInput {
  reviewId: string;
  /** Celui qui tient la réservation. Un autre ne peut pas conclure à sa place. */
  owner: string;
  reviewer: 'GPT' | 'GUARD';
  decision: SupervisorDecisionKind;
  code: string;
  reason: string;
  decisionJson?: Record<string, unknown> | null;
  diffHash?: string | null;
  model?: string | null;
  calls?: number;
  costUsd?: number | null;
  /** L'effet sur l'objectif. `CONTINUE` : un cycle de plus, avec une suite. */
  objectiveEffect:
    | { kind: 'CONTINUE'; correction: boolean }
    | { kind: 'COMPLETE'; result: Record<string, unknown> }
    | { kind: 'BLOCKED' };
  /** La suite, pour NEXT_TASK / CORRECT. Créée dans la même transaction, ou pas du tout. */
  child?: { task: CreateTaskInput; claimKey: string; claimKind: string; claimedBy: string } | null;
}

export type DecideResult =
  | { recorded: true; review: SupervisorReview; objective: SupervisorObjective; child: TaskRow | null }
  | { recorded: false; reason: string };

export class SupervisorRepository {
  constructor(private readonly db: Db, private readonly tasks: TaskRepository) {}

  // --- Objectifs ------------------------------------------------------------

  /**
   * Inscrire un objectif, ou retrouver celui qui existe.
   *
   * `INSERT OR IGNORE` : la racine est unique, l'identifiant aussi. Relire après
   * coup rend la même ligne à tous les appelants, qu'ils l'aient créée ou non.
   */
  ensureObjective(input: EnsureObjectiveInput): { objective: SupervisorObjective; created: boolean } {
    const now = nowIso();
    const outcome = this.db
      .prepare(
        `INSERT OR IGNORE INTO supervisor_objectives
           (objective_id, root_task_id, chain_id, source, objective, spec_json, status,
            max_cycles, max_corrections, max_cost_usd, deadline_at, cycles, corrections,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(
        input.objectiveId, input.rootTaskId, input.chainId, input.source, input.objective,
        JSON.stringify(input.spec), input.maxCycles, input.maxCorrections, input.maxCostUsd,
        input.deadlineAt, now, now,
      );
    const objective = this.objective(input.objectiveId) ?? this.objectiveByRoot(input.rootTaskId);
    if (!objective) throw new Error(`objectif ${input.objectiveId} introuvable après inscription`);
    return { objective, created: outcome.changes === 1 };
  }

  objective(objectiveId: string): SupervisorObjective | null {
    const row = this.db.prepare('SELECT * FROM supervisor_objectives WHERE objective_id = ?').get(objectiveId) as
      | Record<string, unknown> | undefined;
    return row ? toObjective(row) : null;
  }

  objectiveByRoot(rootTaskId: string): SupervisorObjective | null {
    const row = this.db.prepare('SELECT * FROM supervisor_objectives WHERE root_task_id = ?').get(rootTaskId) as
      | Record<string, unknown> | undefined;
    return row ? toObjective(row) : null;
  }

  objectives(options: { status?: ObjectiveStatus; limit?: number } = {}): SupervisorObjective[] {
    const rows = (options.status
      ? this.db.prepare('SELECT * FROM supervisor_objectives WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(options.status, options.limit ?? 50)
      : this.db.prepare('SELECT * FROM supervisor_objectives ORDER BY created_at DESC LIMIT ?')
        .all(options.limit ?? 50)) as Array<Record<string, unknown>>;
    return rows.map(toObjective);
  }

  /** Le commit de départ de l'objectif : posé une fois, jamais réécrit. */
  pinBaseCommit(objectiveId: string, baseCommit: string): SupervisorObjective | null {
    this.db
      .prepare(
        `UPDATE supervisor_objectives SET base_commit = ?, updated_at = ?
          WHERE objective_id = ? AND base_commit IS NULL`,
      )
      .run(baseCommit, nowIso(), objectiveId);
    return this.objective(objectiveId);
  }

  /** Une note d'exploitation : ce qui retient l'objectif sans le terminer (budget du jour…). */
  note(objectiveId: string, text: string): void {
    this.db
      .prepare('UPDATE supervisor_objectives SET last_note = ?, updated_at = ? WHERE objective_id = ?')
      .run(text.slice(0, 1_000), nowIso(), objectiveId);
  }

  /**
   * Terminer un objectif en BLOCKED hors de toute revue (délai dépassé…).
   *
   * Conditionnel à ACTIVE : un objectif déjà terminé ne change pas d'issue, et
   * deux sondeurs qui constatent le même délai n'écrivent qu'une fois.
   */
  blockObjective(objectiveId: string, code: string, reason: string): boolean {
    const now = nowIso();
    return this.db
      .prepare(
        `UPDATE supervisor_objectives
            SET status = 'BLOCKED', terminal_code = ?, terminal_reason = ?, updated_at = ?, finished_at = ?
          WHERE objective_id = ? AND status = 'ACTIVE'`,
      )
      .run(code, reason.slice(0, 2_000), now, now, objectiveId).changes === 1;
  }

  // --- Revues ---------------------------------------------------------------

  reviewForTask(taskId: string): SupervisorReview | null {
    const row = this.db.prepare('SELECT * FROM supervisor_reviews WHERE task_id = ?').get(taskId) as
      | Record<string, unknown> | undefined;
    return row ? toReview(row) : null;
  }

  review(reviewId: string): SupervisorReview | null {
    const row = this.db.prepare('SELECT * FROM supervisor_reviews WHERE review_id = ?').get(reviewId) as
      | Record<string, unknown> | undefined;
    return row ? toReview(row) : null;
  }

  reviewsFor(objectiveId: string): SupervisorReview[] {
    const rows = this.db
      .prepare('SELECT * FROM supervisor_reviews WHERE objective_id = ? ORDER BY cycle ASC')
      .all(objectiveId) as Array<Record<string, unknown>>;
    return rows.map(toReview);
  }

  /**
   * Les tâches d'objectif terminées qui n'ont pas encore de décision.
   *
   * Une tâche garée (pause quota, budget) n'est pas terminée : elle reviendra
   * seule. Une réservation encore courante n'est pas rendue ici — c'est
   * `reserveReview` qui décide si elle est reprenable.
   */
  pendingTaskIds(limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.task_id FROM tasks t
          WHERE t.task_type = 'ENGINEERING_CHANGE'
            AND json_extract(t.payload_json, '$.supervisor.objective_id') IS NOT NULL
            AND t.status IN ('DONE', 'FAILED', 'CANCELLED', 'WAITING_HUMAN')
            AND NOT EXISTS (
                  SELECT 1 FROM supervisor_reviews r
                   WHERE r.task_id = t.task_id AND r.state = 'DECIDED'
                )
          ORDER BY COALESCE(t.finished_at, t.created_at) ASC
          LIMIT ?`,
      )
      .all(limit) as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  /**
   * Réserver la revue d'une tâche.
   *
   * L'insertion est la question : `task_id` et `(objective_id, cycle)` sont
   * uniques, et deux sondeurs ne peuvent pas gagner tous deux. Une réservation
   * dont le bail a expiré sans décision — un processus mort en plein appel —
   * est reprise par une mise à jour conditionnelle, dans la limite des
   * tentatives ; au-delà, elle reste et l'appelant bloque l'objectif.
   */
  reserveReview(input: {
    objectiveId: string;
    taskId: string;
    cycle: number;
    owner: string;
    leaseMs: number;
    maxAttempts: number;
    now?: string;
  }): ReserveReviewResult {
    const now = input.now ?? nowIso();
    const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const reviewId = id('svr');
    const inserted = this.db
      .prepare(
        `INSERT INTO supervisor_reviews
           (review_id, objective_id, task_id, cycle, state, attempts, reserved_by, reserved_at, lease_until)
         VALUES (?, ?, ?, ?, 'RESERVED', 1, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(reviewId, input.objectiveId, input.taskId, input.cycle, input.owner, now, leaseUntil);
    if (inserted.changes === 1) {
      return { reserved: true, review: this.review(reviewId)!, retaken: false };
    }

    const existing = this.reviewForTask(input.taskId);
    if (!existing) {
      // Le conflit porte sur (objectif, cycle) : une autre tâche occupe déjà
      // ce cycle. Ce n'est pas une revue à reprendre, c'est un doublon.
      return { reserved: false, review: null, reason: `cycle ${input.cycle} déjà relu pour une autre tâche` };
    }
    if (existing.state === 'DECIDED') return { reserved: false, review: existing, reason: 'déjà décidée' };
    if (existing.leaseUntil > now) return { reserved: false, review: existing, reason: `réservée par ${existing.reservedBy}` };
    if (existing.attempts >= input.maxAttempts) {
      return { reserved: false, review: existing, reason: `réservation expirée après ${existing.attempts} tentative(s)` };
    }
    const retaken = this.db
      .prepare(
        `UPDATE supervisor_reviews
            SET reserved_by = ?, reserved_at = ?, lease_until = ?, attempts = attempts + 1
          WHERE review_id = ? AND state = 'RESERVED' AND lease_until = ? AND attempts = ?`,
      )
      .run(input.owner, now, leaseUntil, existing.reviewId, existing.leaseUntil, existing.attempts);
    if (retaken.changes === 1) return { reserved: true, review: this.review(existing.reviewId)!, retaken: true };
    return { reserved: false, review: this.review(existing.reviewId), reason: 'reprise par un autre sondeur' };
  }

  /**
   * Rendre une réservation sans décider : l'appel n'a pas pu partir (budget du
   * jour, limitation de débit). Seul celui qui la tient peut la rendre, et
   * seulement tant qu'elle est ouverte.
   */
  releaseReview(reviewId: string, owner: string): boolean {
    return this.db
      .prepare(`DELETE FROM supervisor_reviews WHERE review_id = ? AND reserved_by = ? AND state = 'RESERVED'`)
      .run(reviewId, owner).changes === 1;
  }

  /**
   * Consigner une décision — et tout ce qu'elle entraîne — ou rien.
   *
   * Une seule transaction IMMEDIATE : la réservation est relue (toujours à
   * nous, toujours ouverte), l'objectif relu (toujours actif), la suite créée
   * par le registre des opérations externes avec sa clé de cycle, la revue
   * scellée, l'objectif avancé ou terminé. Un arrêt au milieu ne laisse rien :
   * ni suite sans décision, ni décision sans suite.
   */
  decide(input: DecideInput): DecideResult {
    const write = this.db.transaction((): DecideResult => {
      const review = this.review(input.reviewId);
      if (!review) return { recorded: false, reason: 'revue inconnue' };
      if (review.state !== 'RESERVED') return { recorded: false, reason: 'revue déjà décidée' };
      if (review.reservedBy !== input.owner) {
        return { recorded: false, reason: `réservation tenue par ${review.reservedBy}, pas par ${input.owner}` };
      }
      const objective = this.objective(review.objectiveId);
      if (!objective) return { recorded: false, reason: 'objectif inconnu' };
      const now = nowIso();

      let child: TaskRow | null = null;
      if (input.objectiveEffect.kind === 'CONTINUE') {
        if (objective.status !== 'ACTIVE') return { recorded: false, reason: `objectif ${objective.status}` };
        if (!input.child) return { recorded: false, reason: 'une suite est requise pour continuer' };
        const claim = this.tasks.createClaimedTask(input.child.task, {
          idempotencyKey: input.child.claimKey,
          kind: input.child.claimKind,
          target: objective.objectiveId,
          summary: `cycle ${objective.cycles + 1}`,
          claimedBy: input.child.claimedBy,
        });
        // La clé de cycle est déjà prise : une suite existe pour ce cycle. On
        // ne décide rien plutôt que d'en poser une seconde.
        if (!claim.claimed) return { recorded: false, reason: `suite du cycle déjà posée (${claim.taskId ?? 'sans tâche'})` };
        if (!claim.created) return { recorded: false, reason: `suite déjà existante (${claim.task.taskId})` };
        child = claim.task;
        const advanced = this.db
          .prepare(
            `UPDATE supervisor_objectives
                SET cycles = cycles + 1, corrections = corrections + ?, updated_at = ?, last_note = NULL
              WHERE objective_id = ? AND status = 'ACTIVE' AND cycles = ?`,
          )
          .run(input.objectiveEffect.correction ? 1 : 0, now, objective.objectiveId, objective.cycles);
        if (advanced.changes !== 1) throw new Error('objectif modifié pendant la décision');
      } else if (objective.status === 'ACTIVE') {
        const terminal = input.objectiveEffect.kind;
        this.db
          .prepare(
            `UPDATE supervisor_objectives
                SET status = ?, terminal_code = ?, terminal_reason = ?, terminal_review_id = ?,
                    result_json = ?, updated_at = ?, finished_at = ?
              WHERE objective_id = ? AND status = 'ACTIVE'`,
          )
          .run(
            terminal, input.code, input.reason.slice(0, 2_000), review.reviewId,
            terminal === 'COMPLETE' ? JSON.stringify(input.objectiveEffect.result) : null,
            now, now, objective.objectiveId,
          );
      }

      const sealed = this.db
        .prepare(
          `UPDATE supervisor_reviews
              SET state = 'DECIDED', reviewer = ?, decision = ?, code = ?, reason = ?, decision_json = ?,
                  diff_hash = ?, child_task_id = ?, model = ?, calls = ?, cost_usd = ?, decided_at = ?
            WHERE review_id = ? AND state = 'RESERVED' AND reserved_by = ?`,
        )
        .run(
          input.reviewer, input.decision, input.code, input.reason.slice(0, 2_000),
          input.decisionJson ? JSON.stringify(input.decisionJson) : null,
          input.diffHash ?? null, child?.taskId ?? null, input.model ?? null, input.calls ?? 0,
          input.costUsd ?? null, now, input.reviewId, input.owner,
        );
      if (sealed.changes !== 1) throw new Error('réservation perdue pendant la décision');
      return { recorded: true, review: this.review(input.reviewId)!, objective: this.objective(objective.objectiveId)!, child };
    });
    return write.immediate();
  }
}
