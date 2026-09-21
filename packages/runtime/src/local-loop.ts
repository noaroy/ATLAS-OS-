import type { Logger } from '@atlas/core';
import type { Repositories, AutopilotActionStatus } from '@atlas/data';
import { checkCommand } from './ai-contracts.ts';
import { AtlasDaemon } from './daemon.ts';
import type { WorkerRegistry } from './workers.ts';
import { verdictFromTasks } from './autopilot.ts';

/**
 * La boucle locale, en bibliothèque plutôt qu'en script.
 *
 * C'est exactement ce que `scripts/local-loop.ts` fait déjà en ligne de
 * commande : une tâche ENGINEERING_CHANGE posée dans la file, servie par le
 * daemon réel sous ses garde-fous habituels, vérifiée tour par tour jusqu'à un
 * état terminal ou un plafond. L'extraire ici permet à la boucle maîtresse
 * (`master-loop.ts`) de la réutiliser directement — sans passer par un
 * sous-processus, sans dupliquer la logique de polling borné.
 */

export interface LocalLoopOptions {
  objective: string;
  allowedPaths: readonly string[];
  testCommands?: readonly string[];
  acceptanceCriteria?: string;
  priority?: number;
  maxAttempts?: number;
  /** Tours de daemon (un tour = une réclamation + exécution, ou une attente). Défaut 40. */
  maxCycles?: number;
  maxWallMs?: number;
  createdBy?: string;
  /** Le coupe-circuit : Ctrl+C côté appelant. */
  shouldStop?: () => boolean;
}

export interface LocalLoopVerdict {
  status: AutopilotActionStatus;
  reason: string;
  costUsd: number | null;
}

export interface LocalLoopWorkspace {
  path: string;
  state: string;
  filesChanged: number;
  diffLines: number;
  diffHash: string | null;
}

export type LocalLoopStopReason = 'RESOLVED' | 'MAX_CYCLES' | 'MAX_WALL_MS' | 'MANUAL_STOP';

export interface LocalLoopReport {
  taskId: string;
  created: boolean;
  cyclesUsed: number;
  verdict: LocalLoopVerdict;
  workspace: LocalLoopWorkspace | null;
  stopped: LocalLoopStopReason;
}

export interface LocalLoopDeps {
  repos: Repositories;
  registry: WorkerRegistry;
  logger: Logger;
}

const TERMINAL = new Set<AutopilotActionStatus>(['DONE', 'WAITING_HUMAN', 'BLOCKED']);

export async function runLocalObjectiveLoop(
  deps: LocalLoopDeps,
  options: LocalLoopOptions,
): Promise<LocalLoopReport> {
  const { repos, registry, logger } = deps;
  const objective = options.objective.trim();
  if (!objective) throw new Error('un objectif est requis');
  if (options.allowedPaths.length === 0) {
    throw new Error('allowedPaths est requis : une tâche d’ingénierie sans périmètre est refusée');
  }
  for (const command of options.testCommands ?? []) {
    const verdict = checkCommand(command);
    if (!verdict.allowed) throw new Error(`commande de test refusée : ${verdict.reason}`);
  }

  const created = repos.tasks.create({
    taskType: 'ENGINEERING_CHANGE',
    department: 'ENGINEERING',
    workerType: 'CLAUDE',
    priority: options.priority ?? 80,
    maxAttempts: options.maxAttempts ?? 2,
    payload: {
      objective,
      allowed_paths: [...options.allowedPaths],
      test_commands: [...(options.testCommands ?? [])],
      ...(options.acceptanceCriteria ? { acceptance_criteria: options.acceptanceCriteria } : {}),
    },
  });

  const maxCyclesTotal = options.maxCycles ?? 40;
  const maxWallMs = options.maxWallMs ?? 30 * 60_000;
  const deadlineAt = Date.now() + maxWallMs;

  let cyclesUsed = 0;
  let verdict = verdictFromTasks(repos, repos.tasks.byId(created.task.taskId)!);
  let stopped: LocalLoopStopReason = 'RESOLVED';

  while (cyclesUsed < maxCyclesTotal && Date.now() < deadlineAt && !TERMINAL.has(verdict.status)) {
    if (options.shouldStop?.()) { stopped = 'MANUAL_STOP'; break; }
    const daemon = new AtlasDaemon({
      repos, registry, logger, owner: options.createdBy ?? 'local-loop',
      workerTypes: ['CLAUDE'], maxCycles: 1, maxIdleMs: 3_000,
    });
    const stats = await daemon.run();
    cyclesUsed += stats.cycles;
    verdict = verdictFromTasks(repos, repos.tasks.byId(created.task.taskId)!);
  }
  if (stopped === 'RESOLVED' && !TERMINAL.has(verdict.status)) {
    stopped = cyclesUsed >= maxCyclesTotal ? 'MAX_CYCLES' : 'MAX_WALL_MS';
  }

  const task = repos.tasks.byId(created.task.taskId)!;
  const workspace = repos.tasks.workspaceFor(task.taskId);

  return {
    taskId: task.taskId,
    created: created.created,
    cyclesUsed,
    verdict: { status: verdict.status, reason: verdict.reason, costUsd: verdict.costUsd },
    workspace: workspace
      ? { path: workspace.path, state: workspace.state, filesChanged: workspace.filesChanged, diffLines: workspace.diffLines, diffHash: workspace.diffHash }
      : null,
    stopped,
  };
}
