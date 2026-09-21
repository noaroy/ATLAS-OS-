import type { AtlasConfig, Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { AiProvider } from '@atlas/llm';
import { checkCommand } from './ai-contracts.ts';
import { runCollabLoop, type CollabLoopReport, type CollabTurn } from './collab-loop.ts';
import { runLocalObjectiveLoop, type LocalLoopReport } from './local-loop.ts';
import type { WorkerRegistry } from './workers.ts';

/**
 * La boucle maîtresse : Claude et GPT décident, la boucle locale exécute.
 *
 * Elle n'ajoute aucune capacité nouvelle — elle relie deux boucles déjà
 * bornées et déjà éprouvées séparément :
 *
 *   décider (collab:loop, en mode décision) → exécuter (local:loop, worktree
 *   isolé) → le résultat réel (diff, tests, erreurs) redevient le contexte du
 *   prochain « décider » → jusqu'à l'objectif, un plafond, ou une porte
 *   humaine.
 *
 * Le point qui tient tout : la boucle locale ne fait jamais rien que
 * `local:loop` seul ne ferait pas déjà — même tâche ENGINEERING_CHANGE, même
 * worktree jetable, même audit, même arrêt à READY_FOR_REVIEW. La boucle
 * maîtresse ne décide donc jamais elle-même d'une action : elle transmet
 * exactement ce que le binôme a arrêté, et refuse de transmettre une décision
 * incomplète (sans chemin autorisé, ou avec une commande hors liste blanche).
 *
 * Elle ne s'arrête jamais sur un envoi, un paiement, un déploiement, une
 * modification de sécurité ou de secret : ces portes n'existent pas dans la
 * liste des tâches que `local:loop` sait exécuter, donc la question ne se pose
 * même pas ici.
 */

export interface MasterLoopOptions {
  objective: string;
  context?: string;
  /** Cycles décider→exécuter. Défaut 5. */
  maxCycles?: number;
  /** Plafond de dépense sur l'ensemble de la boucle (décision + exécution). Défaut 3 $. */
  maxCostUsd?: number;
  /** Plafond de temps sur l'ensemble de la boucle. Défaut 45 min. */
  maxWallMs?: number;
  /** Tours de dialogue par cycle de décision. Défaut 2. */
  collabMaxRoundsPerCycle?: number;
  /** Tours de daemon par action confiée à la boucle locale. Défaut 20. */
  localMaxCyclesPerAction?: number;
  /** Délai par action confiée à la boucle locale. Défaut 10 min. */
  localMaxWallMsPerAction?: number;
  /**
   * Tentatives par action, avant abandon. Défaut 2 (celui de `local:loop`) —
   * une panne transitoire de fournisseur peut réussir au second essai. Une
   * violation de périmètre, elle, ne se corrige jamais toute seule : un appelant
   * qui le sait peut passer 1 pour ne pas payer le délai de reprise pour rien.
   */
  localMaxAttempts?: number;
  createdBy?: string;
  shouldStop?: () => boolean;
}

export interface MasterDecision {
  objectiveReached: boolean;
  actionObjective: string | null;
  allowedPaths: string[];
  testCommands: string[];
  reason: string;
}

export interface MasterCycleRecord {
  cycle: number;
  collab: CollabLoopReport;
  decision: MasterDecision | null;
  execution: LocalLoopReport | null;
}

export type MasterFinalStatus =
  | 'OBJECTIVE_REACHED'
  | 'READY_FOR_HUMAN_DEPLOYMENT'
  | 'BLOCKED'
  | 'BOUNDS_EXHAUSTED';

export interface MasterLoopReport {
  objective: string;
  cycles: MasterCycleRecord[];
  finalStatus: MasterFinalStatus;
  reason: string;
  totalCostUsd: number;
}

export interface MasterLoopDeps {
  repos: Repositories;
  config: AtlasConfig;
  providers: { anthropic: AiProvider; openai: AiProvider };
  registry: WorkerRegistry;
  logger: Logger;
}

/**
 * Ce qu'un cycle de décision a produit — ou rien, si le binôme n'a pas
 * convergé, ou a convergé sur une décision incomplète.
 *
 * Les commandes de test hors liste blanche sont retirées plutôt que de faire
 * échouer tout le cycle : la boucle locale les aurait de toute façon refusées
 * une par une avant tout appel ; les filtrer ici évite juste de perdre le
 * reste d'une décision par ailleurs valable.
 */
function extractDecision(collab: CollabLoopReport): MasterDecision | null {
  if (!collab.converged) return null;
  const last: CollabTurn | undefined = collab.turns[collab.turns.length - 1];
  if (!last) return null;

  const objectiveReached = last.objectiveReached === true;
  if (objectiveReached) {
    return { objectiveReached: true, actionObjective: null, allowedPaths: [], testCommands: [], reason: last.reason };
  }
  const allowedPaths = (last.actionAllowedPaths ?? []).filter(Boolean);
  const actionObjective = last.actionObjective;
  const testCommands = (last.actionTestCommands ?? []).filter((c) => checkCommand(c).allowed);
  if (!actionObjective || allowedPaths.length === 0) return null;

  return { objectiveReached: false, actionObjective, allowedPaths, testCommands, reason: last.reason };
}

/** Le contexte donné au cycle suivant : ce que les cycles précédents ont décidé, et ce qui en est réellement sorti. */
function buildHistoryContext(cycles: readonly MasterCycleRecord[]): string | undefined {
  if (cycles.length === 0) return undefined;
  return cycles
    .map((c) => {
      const parts = [`### Cycle ${c.cycle}`];
      if (c.decision?.objectiveReached) {
        parts.push(`Décision précédente : objectif déclaré atteint — ${c.decision.reason}`);
      } else if (c.decision) {
        parts.push(`Action décidée : ${c.decision.actionObjective}\nChemins : ${c.decision.allowedPaths.join(', ')}`);
      } else {
        parts.push('Aucune décision exploitable ce cycle-là (pas de convergence, ou décision incomplète).');
      }
      if (c.execution) {
        parts.push(
          `Résultat réel : ${c.execution.verdict.status} — ${c.execution.verdict.reason}`
          + (c.execution.workspace ? `\nDiff : ${c.execution.workspace.filesChanged} fichier(s), ${c.execution.workspace.diffLines} ligne(s)` : ''),
        );
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

export async function runMasterLoop(deps: MasterLoopDeps, options: MasterLoopOptions): Promise<MasterLoopReport> {
  const { repos, config, providers, registry, logger } = deps;
  const objective = options.objective.trim();
  if (!objective) throw new Error('un objectif est requis');

  const maxCycles = Math.max(1, options.maxCycles ?? 5);
  const maxCostUsd = options.maxCostUsd ?? 3;
  const maxWallMs = options.maxWallMs ?? 45 * 60_000;
  const deadlineAt = Date.now() + maxWallMs;

  const cycles: MasterCycleRecord[] = [];
  let totalCostUsd = 0;

  const finish = (finalStatus: MasterFinalStatus, reason: string): MasterLoopReport => ({
    objective, cycles, finalStatus, reason,
    totalCostUsd: Math.round(totalCostUsd * 10_000) / 10_000,
  });

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (options.shouldStop?.()) return finish('BOUNDS_EXHAUSTED', `arrêt demandé après ${cycle - 1} cycle(s)`);
    if (Date.now() >= deadlineAt) return finish('BOUNDS_EXHAUSTED', `délai maximal atteint après ${cycle - 1} cycle(s)`);
    const remainingBudget = maxCostUsd - totalCostUsd;
    if (remainingBudget <= 0) {
      return finish('BOUNDS_EXHAUSTED', `plafond de coût atteint (${totalCostUsd.toFixed(4)} $ / ${maxCostUsd.toFixed(2)} $)`);
    }

    const historyContext = buildHistoryContext(cycles);
    const context = options.context && historyContext
      ? `${options.context}\n\n${historyContext}`
      : options.context ?? historyContext;

    const collab = await runCollabLoop(
      { repos, config, providers, logger },
      {
        objective,
        context,
        decisionMode: true,
        maxRounds: options.collabMaxRoundsPerCycle ?? 2,
        maxCostUsd: Math.min(remainingBudget, 0.75),
        chainId: null,
        taskId: null,
      },
    );
    totalCostUsd += collab.totalCostUsd;

    const decision = extractDecision(collab);

    if (!decision) {
      cycles.push({ cycle, collab, decision: null, execution: null });
      continue; // pas de décision exploitable ce cycle-ci : on retente, dans la limite de maxCycles.
    }

    if (decision.objectiveReached) {
      cycles.push({ cycle, collab, decision, execution: null });
      return finish('OBJECTIVE_REACHED', decision.reason);
    }

    const remainingAfterCollab = maxCostUsd - totalCostUsd;
    if (remainingAfterCollab <= 0) {
      cycles.push({ cycle, collab, decision, execution: null });
      return finish('BOUNDS_EXHAUSTED', `plafond de coût atteint avant l'exécution (${totalCostUsd.toFixed(4)} $ / ${maxCostUsd.toFixed(2)} $)`);
    }

    const remainingWallMs = deadlineAt - Date.now();
    const execution = await runLocalObjectiveLoop(
      { repos, registry, logger },
      {
        objective: decision.actionObjective!,
        allowedPaths: decision.allowedPaths,
        testCommands: decision.testCommands,
        maxCycles: options.localMaxCyclesPerAction ?? 20,
        maxWallMs: Math.max(1, Math.min(options.localMaxWallMsPerAction ?? 10 * 60_000, remainingWallMs)),
        maxAttempts: options.localMaxAttempts,
        createdBy: options.createdBy ?? 'master-loop',
        shouldStop: options.shouldStop,
      },
    );
    totalCostUsd += execution.verdict.costUsd ?? 0;
    cycles.push({ cycle, collab, decision, execution });

    if (execution.verdict.status === 'BLOCKED') {
      return finish('BLOCKED', execution.verdict.reason);
    }
    if (execution.verdict.status === 'WAITING_HUMAN') {
      // Recouvre READY_FOR_HUMAN_DEPLOYMENT (diff prêt) et toute autre raison
      // d'attente humaine (budget, provider) : dans les deux cas, une porte
      // humaine existante s'est refermée — ce n'est jamais à cette boucle de
      // la franchir.
      return finish('READY_FOR_HUMAN_DEPLOYMENT', execution.verdict.reason);
    }
    // DONE sans diff en attente, ou non résolu dans les bornes de l'action
    // (QUEUED/RUNNING) : le résultat nourrit le contexte du cycle suivant.
  }

  return finish('BOUNDS_EXHAUSTED', `${maxCycles} cycle(s) : plafond atteint`);
}
