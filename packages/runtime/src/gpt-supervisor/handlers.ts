import type { AtlasConfig } from '@atlas/core';
import type { Repositories, SupervisorObjective, SupervisorReview, TaskRow } from '@atlas/data';
import { checkCommand, taskFingerprint, targetOf } from '../ai-contracts.ts';
import { routeTask } from '../hermes-router.ts';
import { checkControllerPath, clampLimits } from '../controller/schema.ts';
import type { WorkerContext, WorkerOutcome } from '../workers.ts';
import {
  SUPERVISOR_FIXED_CONSTRAINTS, objectiveIdFor, objectiveInputFromRoot, runSupervisorPoll, supervisorBlockOf, supervisorReadiness,
  type SupervisorReadiness,
} from './engine.ts';
import {
  SUPERVISOR_LEDGER, SUPERVISOR_OBJECTIVE_SCHEMA, SUPERVISOR_POLL_TASK_TYPE, SUPERVISOR_TASK_TYPE, type GptSupervisorDeps,
} from './types.ts';

/**
 * La tâche `SUPERVISOR_REVIEW_POLL`, servie par le worker déterministe du
 * serveur — celui qui a la clé OpenAI. Le runner d'ingénierie ne la voit
 * jamais : il n'a ni cette clé, ni cette file.
 */
export function createSupervisorHandlers(deps: GptSupervisorDeps): Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> {
  const handler = async (task: TaskRow): Promise<WorkerOutcome> => {
    const report = await runSupervisorPoll({ ...deps, actor: `${deps.actor ?? 'gpt-supervisor'}:${task.taskId}` });
    return { kind: 'DONE', result: { ...report }, costUsd: report.costUsd };
  };
  return { [SUPERVISOR_POLL_TASK_TYPE]: handler };
}

/**
 * Poser le tour de la période, une seule fois : même mécanisme que le pont
 * contrôleur et l'Autopilot. Rien n'est posé tant que le superviseur est fermé.
 */
export function scheduleSupervisorPoll(repos: Repositories, config: AtlasConfig, now: Date): { created: string[]; existing: string[] } {
  if (!config.supervisor.enabled) return { created: [], existing: [] };
  const every = config.supervisor.pollMinutes;
  const key = `supervisor:poll:${every}m:${Math.floor(now.getTime() / (every * 60_000))}`;
  const { created } = repos.tasks.create({
    taskType: SUPERVISOR_POLL_TASK_TYPE,
    department: 'ENGINEERING',
    workerType: routeTask(SUPERVISOR_POLL_TASK_TYPE).target,
    priority: 15,
    payload: { scheduledBy: 'supervisor-scheduler', period: key },
    availableAt: now.toISOString(),
    maxAttempts: 1,
    idempotencyKey: key,
    correlationId: key,
  });
  return created ? { created: [key], existing: [] } : { created: [], existing: [key] };
}

export interface StartObjectiveInput {
  /** La clé d'idempotence : la même clé ne lance jamais deux objectifs. */
  key: string;
  objective: string;
  allowedPaths: readonly string[];
  testCommands?: readonly string[];
  acceptanceCriteria?: readonly string[];
  constraints?: readonly string[];
  limits?: { max_files_changed?: number; max_diff_lines?: number; timeout_minutes?: number };
  repoTarget?: string | null;
  source?: string;
  createdBy?: string;
}

export type StartObjectiveResult =
  | { ok: true; created: boolean; objective: SupervisorObjective; rootTask: TaskRow }
  | { ok: false; reasons: string[] };

/**
 * Lancer un objectif autonome : sa tâche racine et son inscription, ensemble.
 *
 * Mêmes validations que le pont contrôleur — chemins littéraux hors zones
 * protégées, commandes de la liste blanche, bornes ramenées au plafond — parce
 * que la suite sera exécutée par le même worker, sous les mêmes gardes.
 */
export function startObjective(repos: Repositories, config: AtlasConfig, input: StartObjectiveInput): StartObjectiveResult {
  const reasons: string[] = [];
  const key = input.key.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(key)) reasons.push('clé : 3 à 80 caractères [A-Za-z0-9._:-]');
  const objective = input.objective.trim();
  if (objective.length < 10 || objective.length > 4_000) reasons.push('objectif : 10 à 4 000 caractères');
  const paths: string[] = [];
  if (input.allowedPaths.length === 0 || input.allowedPaths.length > 20) reasons.push('allowed_paths : 1 à 20 chemins');
  for (const candidate of input.allowedPaths) {
    const verdict = checkControllerPath(candidate);
    if (!verdict.ok) reasons.push(verdict.reason);
    else if (!paths.includes(verdict.path)) paths.push(verdict.path);
  }
  const commands: string[] = [];
  for (const candidate of input.testCommands ?? []) {
    const verdict = checkCommand(candidate);
    if (!verdict.allowed) reasons.push(`« ${candidate} » : ${verdict.reason}`);
    else commands.push(candidate.trim().replace(/\s+/g, ' '));
  }
  const route = routeTask(SUPERVISOR_TASK_TYPE);
  if (route.target !== 'CLAUDE_CODE') reasons.push(`${SUPERVISOR_TASK_TYPE} routée vers ${route.target}, pas CLAUDE_CODE`);
  if (reasons.length > 0) return { ok: false, reasons };

  const objectiveId = objectiveIdFor(`cli:${key}`);
  const limits = clampLimits(input.limits ?? {}, config).effective;
  const repoTarget = input.repoTarget?.trim() || null;
  const write = repos.db.transaction((): StartObjectiveResult => {
    const claim = repos.tasks.createClaimedTask({
      taskType: SUPERVISOR_TASK_TYPE,
      department: 'ENGINEERING',
      workerType: route.target,
      priority: 10,
      maxAttempts: 1,
      idempotencyKey: `supervisor:task:v1:${objectiveId}:1`,
      correlationId: objectiveId,
      fingerprint: taskFingerprint({ taskType: SUPERVISOR_TASK_TYPE, objective, target: targetOf(repoTarget) }),
      metadata: { source: input.source ?? 'cli', objective_id: objectiveId, cycle: 1, created_by: input.createdBy ?? 'operator' },
      payload: {
        objective,
        allowed_paths: paths,
        test_commands: commands,
        acceptance_criteria: [...(input.acceptanceCriteria ?? [])].map(String).slice(0, 20),
        constraints: [...[...(input.constraints ?? [])].map(String).slice(0, 20), ...SUPERVISOR_FIXED_CONSTRAINTS],
        limits,
        ...(repoTarget ? { repo_target: repoTarget } : {}),
        context: `Objectif autonome ${objectiveId}, cycle 1. Un superviseur GPT relira le résultat et décidera de la suite.`,
        supervisor: {
          schema: SUPERVISOR_OBJECTIVE_SCHEMA, objective_id: objectiveId, cycle: 1, source: input.source ?? 'cli',
          apply: false, push: false, deploy: false,
        },
      },
    }, {
      idempotencyKey: `supervisor:root:v1:${objectiveId}`, kind: SUPERVISOR_LEDGER.ROOT,
      target: objectiveId, summary: key, claimedBy: input.createdBy ?? 'operator',
    });
    const rootTask = claim.claimed ? claim.task : claim.taskId ? repos.tasks.byId(claim.taskId) : null;
    if (!rootTask) return { ok: false, reasons: ['objectif consigné sans tâche racine'] };
    const ensured = objectiveInputFromRoot(rootTask, config);
    if (!ensured) return { ok: false, reasons: ['tâche racine sans bloc supervisor lisible'] };
    const { objective: row, created } = repos.supervisor.ensureObjective(ensured);
    return { ok: true, created: claim.claimed && created, objective: row, rootTask };
  });
  return write.immediate();
}

export interface SupervisorStatus {
  readiness: SupervisorReadiness | null;
  lastPoll: { taskId: string; status: string; finishedAt: string | null; errorCode: string | null } | null;
  objectives: Array<{
    objective: SupervisorObjective;
    reviews: SupervisorReview[];
    tasks: Array<{ taskId: string; cycle: number | null; status: string; resultStatus: string | null; diffHash: string | null }>;
  }>;
}

/** L'état du superviseur, pour le CLI : aucune valeur de clé, seulement des états. */
export function supervisorStatus(repos: Repositories, config: AtlasConfig, deps?: Pick<GptSupervisorDeps, 'provider' | 'pricing'>, limit = 10): SupervisorStatus {
  const last = repos.tasks.lastFinishedOfType(SUPERVISOR_POLL_TASK_TYPE);
  return {
    readiness: deps ? supervisorReadiness({ config, provider: deps.provider, pricing: deps.pricing }) : null,
    lastPoll: last ? { taskId: last.taskId, status: last.status, finishedAt: last.finishedAt, errorCode: last.errorCode } : null,
    objectives: repos.supervisor.objectives({ limit }).map((objective) => ({
      objective,
      reviews: repos.supervisor.reviewsFor(objective.objectiveId),
      tasks: repos.tasks.chainTasks(objective.chainId)
        .filter((t) => t.taskType === SUPERVISOR_TASK_TYPE)
        .map((t) => ({
          taskId: t.taskId,
          cycle: supervisorBlockOf(t)?.cycle ?? null,
          status: t.status,
          resultStatus: typeof t.result?.status === 'string' ? t.result.status : null,
          diffHash: typeof t.result?.diff_hash === 'string' ? t.result.diff_hash : null,
        })),
    })),
  };
}
