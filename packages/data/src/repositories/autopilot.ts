import { id, nowIso } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * La mémoire de l'Autopilot : ses cycles, et la file de ce qu'il a proposé.
 *
 * Deux tables, et une règle chacune. Un cycle est un fait daté — ce qu'il a
 * observé, considéré, décidé, créé, exécuté, et ce que cela a coûté — écrit
 * pour être relu après coup : un système qui décide seul doit pouvoir dire
 * pourquoi. Une action est une intention avec une empreinte stable : deux
 * cycles qui trouvent le même problème ne posent pas deux fois la même
 * action — c'est la base qui le garantit, par un index partiel sur les
 * actions non résolues, pas la vigilance de celui qui écrit.
 */

export type AutopilotCycleStatus = 'RUNNING' | 'DONE' | 'FAILED' | 'INTERRUPTED';

export type AutopilotActionStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'QUEUED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'DONE'
  | 'REJECTED'
  | 'BLOCKED'
  | 'WAITING_HUMAN';

/** Les états d'une action encore ouverte : ceux que l'empreinte dédoublonne. */
export const OPEN_ACTION_STATUSES: readonly AutopilotActionStatus[] = [
  'PROPOSED', 'APPROVED', 'QUEUED', 'RUNNING', 'VERIFYING', 'BLOCKED', 'WAITING_HUMAN',
];

export interface AutopilotCycle {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: AutopilotCycleStatus;
  trigger: string;
  observations: Record<string, unknown>;
  opportunities: unknown[];
  decisions: unknown[];
  actionsCreated: string[];
  executed: unknown[];
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  summary: string | null;
  error: string | null;
}

export interface AutopilotAction {
  id: string;
  fingerprint: string;
  cycleId: string;
  objective: string;
  category: string;
  allocation: string;
  status: AutopilotActionStatus;
  score: number;
  proposal: Record<string, unknown>;
  recommendedAgent: string;
  requiresHumanApproval: boolean;
  reason: string;
  taskId: string | null;
  result: Record<string, unknown> | null;
  rejectionReason: string | null;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  parentActionId: string | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface CycleRow {
  id: string; started_at: string; finished_at: string | null; status: AutopilotCycleStatus; trigger: string;
  observations_json: string; opportunities_json: string; decisions_json: string; actions_created_json: string;
  executed_json: string; estimated_cost_usd: number; actual_cost_usd: number | null; summary: string | null; error: string | null;
}

interface ActionRow {
  id: string; fingerprint: string; cycle_id: string; objective: string; category: string; allocation: string;
  status: AutopilotActionStatus; score: number; proposal_json: string; recommended_agent: string;
  requires_human_approval: number; reason: string; task_id: string | null; result_json: string | null;
  rejection_reason: string | null; estimated_cost_usd: number; actual_cost_usd: number | null;
  parent_action_id: string | null; depth: number; created_at: string; updated_at: string; resolved_at: string | null;
}

const toCycle = (r: CycleRow): AutopilotCycle => ({
  id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, trigger: r.trigger,
  observations: fromJson<Record<string, unknown>>(r.observations_json, {}),
  opportunities: fromJson<unknown[]>(r.opportunities_json, []),
  decisions: fromJson<unknown[]>(r.decisions_json, []),
  actionsCreated: fromJson<string[]>(r.actions_created_json, []),
  executed: fromJson<unknown[]>(r.executed_json, []),
  estimatedCostUsd: Number(r.estimated_cost_usd ?? 0),
  actualCostUsd: r.actual_cost_usd === null ? null : Number(r.actual_cost_usd),
  summary: r.summary, error: r.error,
});

const toAction = (r: ActionRow): AutopilotAction => ({
  id: r.id, fingerprint: r.fingerprint, cycleId: r.cycle_id, objective: r.objective, category: r.category,
  allocation: r.allocation, status: r.status, score: Number(r.score),
  proposal: fromJson<Record<string, unknown>>(r.proposal_json, {}),
  recommendedAgent: r.recommended_agent, requiresHumanApproval: r.requires_human_approval === 1, reason: r.reason,
  taskId: r.task_id, result: r.result_json ? fromJson<Record<string, unknown>>(r.result_json, {}) : null,
  rejectionReason: r.rejection_reason, estimatedCostUsd: Number(r.estimated_cost_usd ?? 0),
  actualCostUsd: r.actual_cost_usd === null ? null : Number(r.actual_cost_usd),
  parentActionId: r.parent_action_id, depth: Number(r.depth ?? 0),
  createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
});

export class AutopilotRepository {
  constructor(private readonly db: Db) {}

  // ─── Les cycles ────────────────────────────────────────────────────────────

  startCycle(input: { trigger: string; startedAt?: string }): AutopilotCycle {
    const cycleId = id('apc');
    const startedAt = input.startedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO autopilot_cycles (id, started_at, status, trigger)
         VALUES (?, ?, 'RUNNING', ?)`,
      )
      .run(cycleId, startedAt, input.trigger);
    return this.cycle(cycleId)!;
  }

  finishCycle(cycleId: string, input: {
    status: Exclude<AutopilotCycleStatus, 'RUNNING'>;
    observations?: Record<string, unknown>;
    opportunities?: unknown[];
    decisions?: unknown[];
    actionsCreated?: string[];
    executed?: unknown[];
    estimatedCostUsd?: number;
    actualCostUsd?: number | null;
    summary?: string | null;
    error?: string | null;
    finishedAt?: string;
  }): AutopilotCycle {
    this.db
      .prepare(
        `UPDATE autopilot_cycles SET
           finished_at = ?, status = ?, observations_json = ?, opportunities_json = ?, decisions_json = ?,
           actions_created_json = ?, executed_json = ?, estimated_cost_usd = ?, actual_cost_usd = ?, summary = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        input.finishedAt ?? nowIso(), input.status,
        toJson(input.observations ?? {}), toJson(input.opportunities ?? []), toJson(input.decisions ?? []),
        toJson(input.actionsCreated ?? []), toJson(input.executed ?? []),
        input.estimatedCostUsd ?? 0, input.actualCostUsd ?? null, input.summary ?? null, input.error ?? null,
        cycleId,
      );
    return this.cycle(cycleId)!;
  }

  /**
   * Les cycles restés ouverts : un processus arrêté avant d'avoir conclu.
   *
   * Ils sont marqués INTERRUPTED, jamais effacés — ce qu'ils avaient observé
   * reste lisible, et la file qu'ils ont laissée est reprise par le cycle
   * suivant.
   */
  interruptOpenCycles(reason = 'cycle laissé ouvert : repris par un nouveau cycle'): string[] {
    const open = this.db
      .prepare("SELECT id FROM autopilot_cycles WHERE status = 'RUNNING'")
      .all() as Array<{ id: string }>;
    for (const row of open) {
      this.db
        .prepare("UPDATE autopilot_cycles SET status = 'INTERRUPTED', finished_at = ?, error = ? WHERE id = ?")
        .run(nowIso(), reason, row.id);
    }
    return open.map((r) => r.id);
  }

  cycle(cycleId: string): AutopilotCycle | null {
    const row = this.db.prepare('SELECT * FROM autopilot_cycles WHERE id = ?').get(cycleId) as CycleRow | undefined;
    return row ? toCycle(row) : null;
  }

  cycles(limit = 20): AutopilotCycle[] {
    return (
      this.db.prepare('SELECT * FROM autopilot_cycles ORDER BY started_at DESC LIMIT ?').all(limit) as CycleRow[]
    ).map(toCycle);
  }

  lastCycle(): AutopilotCycle | null {
    return this.cycles(1)[0] ?? null;
  }

  // ─── Les actions ───────────────────────────────────────────────────────────

  /**
   * Proposer une action — une seule fois tant qu'elle n'est pas résolue.
   *
   * L'index partiel refuse une seconde action ouverte de même empreinte ; on
   * la cherche d'abord pour rendre l'existante plutôt qu'une erreur, et pour
   * que l'appelant sache qu'il n'a rien créé.
   */
  propose(input: {
    cycleId: string;
    fingerprint: string;
    objective: string;
    category: string;
    allocation: string;
    score: number;
    proposal: Record<string, unknown>;
    recommendedAgent: string;
    requiresHumanApproval: boolean;
    reason: string;
    status?: AutopilotActionStatus;
    estimatedCostUsd?: number;
    parentActionId?: string | null;
    depth?: number;
    rejectionReason?: string | null;
  }): { action: AutopilotAction; created: boolean } {
    const existing = this.openByFingerprint(input.fingerprint);
    if (existing) return { action: existing, created: false };

    const actionId = id('apa');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO autopilot_actions
           (id, fingerprint, cycle_id, objective, category, allocation, status, score, proposal_json,
            recommended_agent, requires_human_approval, reason, task_id, result_json, rejection_reason,
            estimated_cost_usd, actual_cost_usd, parent_action_id, depth, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId, input.fingerprint, input.cycleId, input.objective, input.category, input.allocation,
        input.status ?? 'PROPOSED', input.score, toJson(input.proposal),
        input.recommendedAgent, input.requiresHumanApproval ? 1 : 0, input.reason,
        input.rejectionReason ?? null, input.estimatedCostUsd ?? 0,
        input.parentActionId ?? null, input.depth ?? 0, now, now,
        input.status && !OPEN_ACTION_STATUSES.includes(input.status) ? now : null,
      );
    return { action: this.action(actionId)!, created: true };
  }

  openByFingerprint(fingerprint: string): AutopilotAction | null {
    const placeholders = OPEN_ACTION_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM autopilot_actions WHERE fingerprint = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
      .get(fingerprint, ...OPEN_ACTION_STATUSES) as ActionRow | undefined;
    return row ? toAction(row) : null;
  }

  /** La dernière résolution d'une empreinte, pour ne pas refaire ce qui vient d'être fait. */
  lastResolvedByFingerprint(fingerprint: string): AutopilotAction | null {
    const row = this.db
      .prepare("SELECT * FROM autopilot_actions WHERE fingerprint = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 1")
      .get(fingerprint) as ActionRow | undefined;
    return row ? toAction(row) : null;
  }

  action(actionId: string): AutopilotAction | null {
    const row = this.db.prepare('SELECT * FROM autopilot_actions WHERE id = ?').get(actionId) as ActionRow | undefined;
    return row ? toAction(row) : null;
  }

  byTask(taskId: string): AutopilotAction | null {
    const row = this.db.prepare('SELECT * FROM autopilot_actions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as ActionRow | undefined;
    return row ? toAction(row) : null;
  }

  actions(filter: { status?: AutopilotActionStatus | readonly AutopilotActionStatus[]; limit?: number; cycleId?: string } = {}): AutopilotAction[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.cycleId) { clauses.push('cycle_id = ?'); params.push(filter.cycleId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.db
        .prepare(`SELECT * FROM autopilot_actions ${where} ORDER BY score DESC, created_at DESC LIMIT ?`)
        .all(...params, filter.limit ?? 100) as ActionRow[]
    ).map(toAction);
  }

  openActions(): AutopilotAction[] {
    return this.actions({ status: OPEN_ACTION_STATUSES, limit: 500 });
  }

  /** Les actions résolues récemment, les plus récentes d'abord : la matière de l'apprentissage. */
  resolvedSince(iso: string, limit = 100): AutopilotAction[] {
    return (
      this.db
        .prepare('SELECT * FROM autopilot_actions WHERE resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT ?')
        .all(iso, limit) as ActionRow[]
    ).map(toAction);
  }

  transition(actionId: string, status: AutopilotActionStatus, patch: {
    taskId?: string | null;
    result?: Record<string, unknown> | null;
    rejectionReason?: string | null;
    actualCostUsd?: number | null;
    reason?: string;
    /** L'instant de la transition : celui du cycle qui la constate, par défaut maintenant. */
    at?: string;
  } = {}): AutopilotAction {
    const current = this.action(actionId);
    if (!current) throw new Error(`action Autopilot inconnue : ${actionId}`);
    const now = patch.at ?? nowIso();
    const resolved = OPEN_ACTION_STATUSES.includes(status) ? null : now;
    this.db
      .prepare(
        `UPDATE autopilot_actions SET status = ?, task_id = ?, result_json = ?, rejection_reason = ?,
           actual_cost_usd = ?, reason = ?, updated_at = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.taskId === undefined ? current.taskId : patch.taskId,
        patch.result === undefined ? (current.result ? toJson(current.result) : null) : (patch.result ? toJson(patch.result) : null),
        patch.rejectionReason === undefined ? current.rejectionReason : patch.rejectionReason,
        patch.actualCostUsd === undefined ? current.actualCostUsd : patch.actualCostUsd,
        patch.reason ?? current.reason,
        now, resolved, actionId,
      );
    return this.action(actionId)!;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM autopilot_actions GROUP BY status').all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
