import type { AtlasConfig } from '@atlas/core';
import type { Repositories, TaskRow } from '@atlas/data';
import type { WorkerContext, WorkerOutcome } from '../workers.ts';
import { routeTask } from '../hermes-router.ts';
import { CONTROLLER_LEDGER, CONTROLLER_POLL_TASK_TYPE, type ControllerDeps } from './types.ts';
import { controllerReadiness, controllerStateOf, runControllerPoll, type ControllerReadiness } from './bridge.ts';

/**
 * La tâche `CONTROLLER_BRIDGE_POLL`, servie par le worker déterministe.
 *
 * Aucun modèle, aucun coût : lire GitHub, valider, poser une tâche, publier.
 * GitHub injoignable sur la liste des issues : FAILED, sans réessai (la tâche
 * est posée avec une seule tentative) — le prochain tour cadencé repassera.
 * C'est ce qui borne les appels : un tour par période, jamais une rafale.
 */
export function createControllerHandlers(deps: ControllerDeps): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  const handler = async (task: TaskRow): Promise<WorkerOutcome> => {
    const report = await runControllerPoll({ ...deps, actor: deps.actor ?? `controller-bridge:${task.taskId}` });
    if (!report.ran && report.errors.length > 0) {
      return {
        kind: 'FAILED',
        errorCode: 'CONTROLLER_GITHUB_UNAVAILABLE',
        errorMessage: report.errors[0]!.slice(0, 500),
        result: { ...report },
      };
    }
    return { kind: 'DONE', result: { ...report }, costUsd: 0 };
  };
  return { [CONTROLLER_POLL_TASK_TYPE]: handler };
}

/**
 * Poser le tour de sondage de la période, une seule fois.
 *
 * Même mécanisme que l'Autopilot : une clé de période, donc un tour par
 * période quel que soit le nombre de passages du planificateur. Rien n'est
 * posé tant que ATLAS_CONTROLLER_ENABLED n'est pas vrai.
 */
export function scheduleControllerPoll(repos: Repositories, config: AtlasConfig, now: Date): { created: string[]; existing: string[] } {
  if (!config.controller.enabled) return { created: [], existing: [] };
  const every = config.controller.pollMinutes;
  const key = `controller:poll:${every}m:${Math.floor(now.getTime() / (every * 60_000))}`;
  const { created } = repos.tasks.create({
    taskType: CONTROLLER_POLL_TASK_TYPE,
    department: 'ENGINEERING',
    workerType: routeTask(CONTROLLER_POLL_TASK_TYPE).target,
    priority: 15,
    payload: { scheduledBy: 'controller-scheduler', period: key },
    availableAt: now.toISOString(),
    maxAttempts: 1,
    idempotencyKey: key,
    correlationId: key,
  });
  return created ? { created: [key], existing: [] } : { created: [], existing: [key] };
}

export interface ControllerStatus {
  readiness: ControllerReadiness;
  lastPoll: { taskId: string; status: string; finishedAt: string | null; errorCode: string | null } | null;
  intakes: Array<{ target: string | null; taskId: string | null; taskStatus: string | null; state: string | null; fingerprint: string | null; claimedAt: string }>;
}

/** L'état du pont, pour le CLI : aucune valeur de jeton, seulement sa source. */
export function controllerStatus(repos: Repositories, config: AtlasConfig, env: NodeJS.ProcessEnv = process.env): ControllerStatus {
  const last = repos.tasks.lastFinishedOfType(CONTROLLER_POLL_TASK_TYPE);
  return {
    readiness: controllerReadiness(config, env),
    lastPoll: last ? { taskId: last.taskId, status: last.status, finishedAt: last.finishedAt, errorCode: last.errorCode } : null,
    intakes: repos.tasks.externalOperationsOfKind(CONTROLLER_LEDGER.INTAKE, 20).map((op) => {
      const task = op.taskId ? repos.tasks.byId(op.taskId) : null;
      return {
        target: op.target,
        taskId: op.taskId,
        taskStatus: task?.status ?? null,
        state: task ? controllerStateOf(task) : null,
        fingerprint: op.summary,
        claimedAt: op.claimedAt,
      };
    }),
  };
}
