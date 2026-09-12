import type { Logger } from '@atlas/core';
import type { TaskRow } from '@atlas/data';

/**
 * Qui exécute quoi.
 *
 * L'abstraction sert une chose précise : que brancher un modèle plus tard ne
 * demande pas de toucher au daemon. Le daemon prend une tâche, trouve le worker
 * qui sait la traiter, et consigne ce qu'il en revient — il n'a aucune raison
 * de savoir si le travail était une soustraction ou un appel réseau.
 *
 * Dans cette version, seul `DETERMINISTIC` travaille réellement. `OPENAI` et
 * `CLAUDE` existent, déclarent leur type, et refusent — parce qu'un worker
 * absent produirait une tâche coincée sans explication, alors qu'un worker qui
 * refuse produit un état lisible.
 */

export type WorkerOutcomeKind =
  | 'DONE'
  | 'FAILED'
  /** Le fournisseur est indisponible : la tâche attend, elle n'échoue pas. */
  | 'PAUSED_QUOTA'
  | 'PAUSED_BUDGET'
  | 'WAITING_HUMAN';

export interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  /** Le fournisseur en cause, quand l'issue est une indisponibilité. */
  provider?: string;
  /** Ce que le fournisseur a répondu, pour dater la reprise sans la deviner. */
  retryAfterHeader?: string | null;
  rateLimitResetHeader?: string | null;
  costUsd?: number | null;
}

export interface WorkerContext {
  logger: Logger;
  /** À appeler régulièrement dans un travail long, sous peine de perdre le bail. */
  heartbeat: () => boolean;
  /** Vrai quand l'arrêt a été demandé : un travail long doit s'y arrêter. */
  shuttingDown: () => boolean;
  correlationId: string | null;
}

export interface Worker {
  readonly type: string;
  readonly capabilities: readonly string[];
  canHandle(task: TaskRow): boolean;
  execute(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome>;
}

/**
 * Le worker déterministe : le seul qui travaille vraiment ici.
 *
 * Les tâches qu'il traite sont enregistrées par leur `task_type`. Un type
 * inconnu n'est pas exécuté « au mieux » — il échoue avec un motif nommé, parce
 * qu'un travail silencieusement sauté sur un système qui tourne seul ne se
 * découvre que bien plus tard, et par ses conséquences.
 */
export class DeterministicWorker implements Worker {
  readonly type = 'DETERMINISTIC';
  private readonly handlers = new Map<
    string,
    (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>
  >();

  constructor(handlers: Record<string, (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>> = {}) {
    for (const [type, handler] of Object.entries(handlers)) this.handlers.set(type, handler);
  }

  register(taskType: string, handler: (task: TaskRow, context: WorkerContext) => Promise<WorkerOutcome>): void {
    this.handlers.set(taskType, handler);
  }

  get capabilities(): readonly string[] {
    return [...this.handlers.keys()];
  }

  canHandle(task: TaskRow): boolean {
    return task.workerType === 'DETERMINISTIC';
  }

  async execute(task: TaskRow, context: WorkerContext): Promise<WorkerOutcome> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) {
      return {
        kind: 'FAILED',
        errorCode: 'NO_HANDLER',
        errorMessage:
          `aucun traitement enregistré pour « ${task.taskType} ». ` +
          `Types connus : ${this.capabilities.join(', ') || 'aucun'}.`,
      };
    }
    return handler(task, context);
  }
}

/**
 * Les workers de modèle, présents et désactivés.
 *
 * Ils ne sont pas des bouchons de test : ce sont les vrais points d'entrée,
 * fermés. Le jour où les modèles seront branchés, c'est `execute` qui changera,
 * pas le daemon ni la file.
 *
 * `WAITING_HUMAN` plutôt que `FAILED` : une tâche destinée à un modèle non
 * branché n'a pas échoué, elle attend une décision — celle de brancher le
 * modèle. La distinction évite de brûler des tentatives sur une absence.
 */
export class DisabledModelWorker implements Worker {
  readonly capabilities: readonly string[] = [];

  constructor(readonly type: 'OPENAI' | 'CLAUDE') {}

  canHandle(task: TaskRow): boolean {
    return task.workerType === this.type;
  }

  async execute(): Promise<WorkerOutcome> {
    return {
      kind: 'WAITING_HUMAN',
      errorCode: 'WORKER_DISABLED',
      errorMessage:
        `le worker ${this.type} n'est pas branché dans cette version. ` +
        'Aucun appel de modèle n\'est effectué.',
    };
  }
}

/**
 * Le worker humain : il ne fait rien, et c'est exactement son rôle.
 *
 * Une tâche qui lui parvient passe en attente et libère la file. Elle ne bloque
 * personne — c'est la propriété qui compte : une approbation oubliée pendant
 * trois jours ne doit pas empêcher les autres travaux d'avancer.
 */
export class HumanWorker implements Worker {
  readonly type = 'HUMAN';
  readonly capabilities = ['APPROVE_EMAIL', 'ANSWER_CLIENT', 'APPROVE_PAYMENT'] as const;

  canHandle(task: TaskRow): boolean {
    return task.workerType === 'HUMAN';
  }

  async execute(task: TaskRow): Promise<WorkerOutcome> {
    return {
      kind: 'WAITING_HUMAN',
      errorCode: 'HUMAN_DECISION_REQUIRED',
      errorMessage: `« ${task.taskType} » attend une décision humaine.`,
    };
  }
}

/** L'annuaire des workers. Le premier qui sait faire prend le travail. */
export class WorkerRegistry {
  private readonly workers: Worker[] = [];

  register(worker: Worker): this {
    this.workers.push(worker);
    return this;
  }

  find(task: TaskRow): Worker | null {
    return this.workers.find((worker) => worker.canHandle(task)) ?? null;
  }

  types(): string[] {
    return this.workers.map((worker) => worker.type);
  }
}
